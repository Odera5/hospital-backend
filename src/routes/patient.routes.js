import express from "express";
import fs from "fs";
import path from "path";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import { requireProOrEnterprise } from "../middleware/subscriptionGuard.js";
import { enforceSubscriptionState } from "../middleware/subscriptionStateGuard.js";
import upload from "../middleware/upload.js";
import { logAuditEvent } from "../services/auditLog.js";
import {
  toDecryptedPatient,
  toEncryptedPatientData,
} from "../utils/patientCrypto.js";
import { serializeRecord } from "../utils/serializers.js";
import { generatePresignedUrl, deleteObjectFromS3 } from "../lib/s3.js";
import { validatePatient } from "../middleware/validators.js";
import {
  buildPatientSearchIndexData,
  clinicHasPendingPatientSearchBackfill,
} from "../services/patientSearchIndex.js";

const router = express.Router();
router.use(protect);
router.use(enforceSubscriptionState({ allowAdminReadOnly: true }));

const normalizeText = (value) =>
  typeof value === "string" ? value.trim() : "";

const isCardNumberMatch = (cardNumberStr, searchStr) => {
  if (!cardNumberStr || !searchStr) return false;
  const cleanCardNumber = String(cardNumberStr).trim().toLowerCase();
  const cleanSearch = String(searchStr).trim().toLowerCase();

  if (cleanCardNumber.includes(cleanSearch)) return true;

  const cardDigitsMatch = cleanCardNumber.match(/(?:p-?|P-?)?(\d+)/i);
  const searchDigitsMatch = cleanSearch.match(/^(?:p-?|P-?)?(\d+)$/i);

  if (cardDigitsMatch && searchDigitsMatch) {
    return (
      parseInt(cardDigitsMatch[1], 10) === parseInt(searchDigitsMatch[1], 10)
    );
  }

  return false;
};

const normalizeTeeth = (value) => {
  if (!value) return [];

  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const allowed = [
    "present",
    "carious",
    "tender",
    "mobile",
    "fractured",
    "missing",
  ];

  return parsed
    .map((tooth) => {
      const number = Number(tooth?.number);
      let conditions = [];

      if (Array.isArray(tooth?.conditions)) {
        conditions = tooth.conditions.filter((c) => allowed.includes(c));
      } else if (
        typeof tooth?.condition === "string" &&
        allowed.includes(tooth.condition)
      ) {
        conditions = [tooth.condition];
      }

      const primaryCondition = conditions[0] || "present";

      return {
        number,
        conditions,
        condition: primaryCondition,
      };
    })
    .filter((tooth) => Number.isFinite(tooth.number));
};

const normalizeDentition = (value) => {
  const dentitions = ["adult", "child", "mixed"];
  return dentitions.includes(value) ? value : "adult";
};

const normalizeAttachments = (attachments) =>
  Array.isArray(attachments) ? attachments : [];

const normalizeVitals = (value) => {
  if (!value) return null;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object") return null;

  const vitals = {};
  if (parsed.bloodPressure && typeof parsed.bloodPressure === "string") {
    // Basic validation for BP format e.g., 120/80
    if (/^\d{2,3}\/\d{2,3}$/.test(parsed.bloodPressure.trim())) {
      vitals.bloodPressure = parsed.bloodPressure.trim();
    }
  }
  if (parsed.heartRate && !isNaN(parseInt(parsed.heartRate))) {
    const hr = parseInt(parsed.heartRate);
    if (hr > 0 && hr < 300) vitals.heartRate = hr;
  }
  if (parsed.temperature && !isNaN(parseFloat(parsed.temperature))) {
    const temp = parseFloat(parsed.temperature);
    if (temp > 20 && temp < 45) vitals.temperature = temp;
  }
  if (parsed.weight && !isNaN(parseFloat(parsed.weight))) {
    const weight = parseFloat(parsed.weight);
    if (weight > 0 && weight < 500) vitals.weight = weight;
  }
  if (parsed.bloodGlucose && !isNaN(parseFloat(parsed.bloodGlucose))) {
    const glucose = parseFloat(parsed.bloodGlucose);
    if (glucose > 0 && glucose < 1000) vitals.bloodGlucose = glucose;
  }

  return Object.keys(vitals).length > 0 ? JSON.stringify(vitals) : null;
};

const normalizeAttachmentMetadataPayload = (value) => {
  if (!value) return [];

  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((attachment) => ({
      name: normalizeText(attachment?.name),
      url: normalizeText(attachment?.url),
      mimetype: normalizeText(attachment?.mimetype || attachment?.type),
    }))
    .filter((attachment) => attachment.name && attachment.url);
};

const normalizeBoolean = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
};

const normalizeConsentPayload = (payload = {}) => {
  const consentObtained = normalizeBoolean(payload.consentObtained);
  const consentTakenBy = normalizeText(payload.consentTakenBy);
  const consentNotes = normalizeText(payload.consentNotes);
  const rawConsentDate = normalizeText(payload.consentDate);
  const consentDate =
    consentObtained && rawConsentDate ? new Date(rawConsentDate) : null;

  return {
    consentObtained,
    consentTakenBy: consentObtained ? consentTakenBy : "",
    consentNotes: consentObtained ? consentNotes : "",
    consentDate:
      consentObtained && consentDate && !Number.isNaN(consentDate.getTime())
        ? consentDate
        : null,
  };
};

const buildAttachmentUrl = (patientId, fileName) =>
  `/api/patients/${patientId}/records/attachments/${encodeURIComponent(fileName)}`;

const getStoredAttachmentName = (file) =>
  path.basename(
    String(file?.key || file?.filename || file?.originalname || ""),
  );

const getLegacyRecordFilePath = (fileName) =>
  path.join(
    process.cwd(),
    "uploads",
    "records",
    path.basename(String(fileName || "")),
  );

const buildExaminationSummary = ({
  examination,
  examinationExtraOral,
  softTissue,
  periodontalStatus,
  occlusion,
}) => {
  const sections = [
    ["General", normalizeText(examination)],
    ["Extra-Oral", normalizeText(examinationExtraOral)],
    ["Soft Tissue", normalizeText(softTissue)],
    ["Periodontal Status", normalizeText(periodontalStatus)],
    ["Occlusion", normalizeText(occlusion)],
  ].filter(([, value]) => value);

  return sections.map(([label, value]) => `${label}: ${value}`).join("\n");
};

const formatCardNumber = (sequence) => `P-${String(sequence).padStart(6, "0")}`;

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const buildPatientSearchWhere = (search) => {
  if (!search) return {};

  const conditions = [
    {
      searchName: {
        contains: search,
      },
    },
    {
      searchCardNumber: {
        contains: search,
      },
    },
    {
      phone: {
        contains: search,
        mode: "insensitive",
      },
    },
  ];

  const parsedAge = parseInt(search, 10);
  if (!isNaN(parsedAge) && String(parsedAge) === search.trim()) {
    conditions.push({
      ageNumber: parsedAge,
    });
  }

  const cardMatch = search.trim().match(/^(?:p-?|P-?)?(\d+)$/i);
  if (cardMatch) {
    const sequenceNumber = parseInt(cardMatch[1], 10);
    if (!isNaN(sequenceNumber)) {
      conditions.push({
        cardNumberSequence: sequenceNumber,
      });
    }
  }

  return { OR: conditions };
};

const buildPatientSortOrder = (sortBy, sortDirection) => {
  if (sortBy === "name") return { searchName: sortDirection };
  if (sortBy === "cardNumber") return { searchCardNumber: sortDirection };
  if (sortBy === "age") return { ageNumber: sortDirection };
  return { createdAt: sortDirection };
};

const normalizeSortDirection = (value, fallback = "desc") =>
  String(value || fallback).toLowerCase() === "asc" ? "asc" : "desc";

const normalizeRecordSortOption = (value) => {
  const normalized = String(value || "recent").toLowerCase();
  return ["recent", "oldest", "diagnosis"].includes(normalized)
    ? normalized
    : "recent";
};

const VALID_PATIENT_SORT_FIELDS = new Set([
  "createdAt",
  "name",
  "age",
  "cardNumber",
]);

const VALID_TRASH_SORT_FIELDS = new Set([
  "updatedAt",
  "createdAt",
  "name",
  "age",
  "cardNumber",
]);

const sortPatientsCollection = (
  patients,
  sortBy = "createdAt",
  sortDirection = "desc",
) => {
  const directionMultiplier = sortDirection === "asc" ? 1 : -1;

  return [...patients].sort((left, right) => {
    let leftValue = left?.[sortBy];
    let rightValue = right?.[sortBy];

    if (sortBy === "age") {
      leftValue = Number(leftValue) || 0;
      rightValue = Number(rightValue) || 0;
    } else if (sortBy === "createdAt") {
      leftValue = new Date(leftValue).getTime() || 0;
      rightValue = new Date(rightValue).getTime() || 0;
    } else {
      leftValue = String(leftValue || "").toLowerCase();
      rightValue = String(rightValue || "").toLowerCase();
    }

    if (leftValue < rightValue) return -1 * directionMultiplier;
    if (leftValue > rightValue) return 1 * directionMultiplier;
    return 0;
  });
};

const isPatientCardSequenceConflict = (error) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  Array.isArray(error.meta?.target) &&
  error.meta.target.includes("clinicId") &&
  error.meta.target.includes("cardNumberSequence");

const createPatientWithGeneratedCardNumber = async ({
  clinicId,
  branchId,
  patientData,
}) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const aggregate = await prisma.patient.aggregate({
        where: { clinicId },
        _max: { cardNumberSequence: true },
      });

      const nextSequence = (aggregate._max.cardNumberSequence || 0) + 1;

      return await prisma.patient.create({
        data: {
          clinicId,
          branchId,
          cardNumberSequence: nextSequence,
          ...buildPatientSearchIndexData({
            ...patientData,
            cardNumber: formatCardNumber(nextSequence),
          }),
          ...toEncryptedPatientData({
            ...patientData,
            cardNumber: formatCardNumber(nextSequence),
          }),
        },
      });
    } catch (error) {
      if (isPatientCardSequenceConflict(error) && attempt < 4) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Failed to generate a unique patient card number");
};

const getPatientOr404 = async (id, clinicId, branchId) => {
  const patient = await prisma.patient.findFirst({ where: { id, clinicId } });
  if (!patient || patient.isDeleted) return null;
  return patient;
};

router.get(
  "/picker",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor", "nurse"),
  async (req, res) => {
    try {
      const clinicId = req.user.clinicId;
      const branchId = req.user.branchId;
      const search = normalizeText(req.query.search).toLowerCase();
      const isGlobal =
        req.query.global === "true" && req.user.clinic?.plan === "ENTERPRISE";
      const limit = Math.min(parsePositiveInteger(req.query.limit, 20), 100);

      const baseWhere = {
        clinicId,
        isDeleted: false,
        ...(isGlobal ? {} : { branchId }),
      };
      const selectedFields = {
        id: true,
        name: true,
        cardNumber: true,
        phone: true,
        email: true,
        createdAt: true,
      };

      const rawPatients = await prisma.patient.findMany({
        where: {
          ...baseWhere,
          ...buildPatientSearchWhere(search),
        },
        select: selectedFields,
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      const options = rawPatients
        .map((patient) => {
          const decrypted = toDecryptedPatient(patient);
          return {
            id: decrypted.id,
            name: decrypted.name,
            cardNumber: decrypted.cardNumber,
            phone: decrypted.phone,
            age: decrypted.age,
          };
        })
        .slice(0, limit);

      res.json(options);
    } catch (error) {
      console.error("Get patient picker error:", error);
      res.status(500).json({ message: "Failed to fetch patient options" });
    }
  },
);

router.get(
  "/",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor", "nurse"),
  async (req, res) => {
    try {
      const clinicId = req.user.clinicId;
      const branchId = req.user.branchId;
      const pageParam = req.query.page;
      const limitParam = req.query.limit;
      const search = normalizeText(req.query.search).toLowerCase();
      const requestedSortBy = normalizeText(req.query.sortBy);
      const sortBy = VALID_PATIENT_SORT_FIELDS.has(requestedSortBy)
        ? requestedSortBy
        : "createdAt";
      const sortDirection = normalizeSortDirection(
        req.query.sortDirection,
        sortBy === "createdAt" ? "desc" : "asc",
      );
      const shouldPaginate =
        pageParam !== undefined || limitParam !== undefined;

      const isGlobal =
        req.query.global === "true" && req.user.clinic?.plan === "ENTERPRISE";
      const baseWhere = {
        clinicId,
        isDeleted: false,
        ...(isGlobal ? {} : { branchId }),
      };

      if (!shouldPaginate) {
        const patients = await prisma.patient.findMany({
          where: baseWhere,
          orderBy: { createdAt: "desc" },
        });

        return res.json(patients.map(toDecryptedPatient));
      }

      const page = parsePositiveInteger(pageParam, 1);
      const limit = Math.min(parsePositiveInteger(limitParam, 25), 100);
      const skip = (page - 1) * limit;
      const requiresIndexedSearchOrSort =
        Boolean(search) || ["name", "age", "cardNumber"].includes(sortBy);
      const canUseIndexedSearchOrSort =
        !requiresIndexedSearchOrSort ||
        !(await clinicHasPendingPatientSearchBackfill(clinicId));

      if (canUseIndexedSearchOrSort) {
        const [patients, total] = await Promise.all([
          prisma.patient.findMany({
            where: {
              ...baseWhere,
              ...buildPatientSearchWhere(search),
            },
            orderBy: buildPatientSortOrder(sortBy, sortDirection),
            skip,
            take: limit,
          }),
          prisma.patient.count({
            where: {
              ...baseWhere,
              ...buildPatientSearchWhere(search),
            },
          }),
        ]);

        return res.json({
          data: patients.map(toDecryptedPatient),
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        });
      }

      const patients = await prisma.patient.findMany({
        where: baseWhere,
        orderBy: { createdAt: "desc" },
      });

      const filteredPatients = patients
        .map(toDecryptedPatient)
        .filter((patient) => {
          if (!search) return true;

          const hasNameMatch =
            patient?.name &&
            String(patient.name).toLowerCase().includes(search);
          const hasAgeMatch =
            patient?.age && String(patient.age).toLowerCase().includes(search);
          const hasCardMatch = isCardNumberMatch(patient?.cardNumber, search);

          return hasNameMatch || hasAgeMatch || hasCardMatch;
        });

      const sortedPatients = sortPatientsCollection(
        filteredPatients,
        sortBy,
        sortDirection,
      );
      const total = sortedPatients.length;
      const paginatedPatients = sortedPatients.slice(skip, skip + limit);

      return res.json({
        data: paginatedPatients,
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (error) {
      console.error("Get patients error:", error);
      res.status(500).json({
        message: "Failed to fetch patients",
        error: error.message,
        stack: error.stack,
      });
    }
  },
);

router.get("/trash/all", protect, authorizeRoles("admin"), async (req, res) => {
  try {
    const clinicId = req.user.clinicId;
    const branchId = req.user.branchId;
    const pageParam = req.query.page;
    const limitParam = req.query.limit;
    const search = normalizeText(req.query.search).toLowerCase();
    const requestedSortBy = normalizeText(req.query.sortBy);
    const sortBy = VALID_TRASH_SORT_FIELDS.has(requestedSortBy)
      ? requestedSortBy
      : "updatedAt";
    const sortDirection = normalizeSortDirection(
      req.query.sortDirection,
      "desc",
    );
    const shouldPaginate = pageParam !== undefined || limitParam !== undefined;
    const isGlobal =
      req.query.global === "true" && req.user.clinic?.plan === "ENTERPRISE";
    const baseWhere = {
      clinicId,
      isDeleted: true,
      ...(isGlobal ? {} : { branchId }),
    };

    if (!shouldPaginate) {
      const trash = await prisma.patient.findMany({
        where: baseWhere,
        orderBy: { updatedAt: "desc" },
      });

      return res.json(trash.map(toDecryptedPatient));
    }

    const page = parsePositiveInteger(pageParam, 1);
    const limit = Math.min(parsePositiveInteger(limitParam, 25), 100);
    const skip = (page - 1) * limit;
    const requiresIndexedSearchOrSort =
      Boolean(search) || ["name", "age", "cardNumber"].includes(sortBy);
    const canUseIndexedSearchOrSort =
      !requiresIndexedSearchOrSort ||
      !(await clinicHasPendingPatientSearchBackfill(clinicId));

    if (canUseIndexedSearchOrSort) {
      const [trash, total] = await Promise.all([
        prisma.patient.findMany({
          where: {
            ...baseWhere,
            ...buildPatientSearchWhere(search),
          },
          orderBy: buildPatientSortOrder(sortBy, sortDirection),
          skip,
          take: limit,
        }),
        prisma.patient.count({
          where: {
            ...baseWhere,
            ...buildPatientSearchWhere(search),
          },
        }),
      ]);

      return res.json({
        data: trash.map(toDecryptedPatient),
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      });
    }

    const trash = await prisma.patient.findMany({
      where: baseWhere,
      orderBy: { updatedAt: "desc" },
    });

    const filteredPatients = trash.map(toDecryptedPatient).filter((patient) => {
      if (!search) return true;

      const hasNameMatch =
        patient?.name && String(patient.name).toLowerCase().includes(search);
      const hasAgeMatch =
        patient?.age && String(patient.age).toLowerCase().includes(search);
      const hasCardMatch = isCardNumberMatch(patient?.cardNumber, search);

      return hasNameMatch || hasAgeMatch || hasCardMatch;
    });

    const sortedPatients = sortPatientsCollection(
      filteredPatients,
      sortBy,
      sortDirection,
    );
    const total = sortedPatients.length;
    const paginatedPatients = sortedPatients.slice(skip, skip + limit);

    return res.json({
      data: paginatedPatients,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("Get trash error:", error);
    res.status(500).json({ message: "Failed to fetch trash" });
  }
});

// PUT /api/patients/trash/restore - Bulk restore patients from trash
router.put(
  "/trash/restore",
  protect,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "No patient IDs provided" });
      }

      const patientsToRestore = await prisma.patient.findMany({
        where: {
          id: { in: ids },
          clinicId: req.user.clinicId,
          isDeleted: true,
        },
      });

      if (patientsToRestore.length === 0) {
        return res
          .status(404)
          .json({ message: "No matching trashed patients found" });
      }

      const restoredIds = patientsToRestore.map((p) => p.id);

      await prisma.patient.updateMany({
        where: { id: { in: restoredIds } },
        data: { isDeleted: false },
      });

      for (const p of patientsToRestore) {
        await logAuditEvent(req, {
          action: "patient.update",
          resourceType: "patient",
          resourceId: p.id,
          patientId: p.id,
          metadata: { restored: true, bulk: true },
        });
      }

      res.json({
        message: `${restoredIds.length} patient(s) restored successfully`,
        restoredIds,
      });
    } catch (error) {
      console.error("Bulk restore error:", error);
      res.status(500).json({ message: "Failed to restore patients" });
    }
  },
);

// DELETE /api/patients/trash/permanent - Bulk permanently delete patients
router.delete(
  "/trash/permanent",
  protect,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "No patient IDs provided" });
      }

      const patientsToDelete = await prisma.patient.findMany({
        where: {
          id: { in: ids },
          clinicId: req.user.clinicId,
          isDeleted: true,
        },
      });

      if (patientsToDelete.length === 0) {
        return res
          .status(404)
          .json({ message: "No matching trashed patients found" });
      }

      const deleteIds = patientsToDelete.map((p) => p.id);

      await prisma.patient.deleteMany({
        where: { id: { in: deleteIds } },
      });

      for (const p of patientsToDelete) {
        await logAuditEvent(req, {
          action: "patient.delete",
          resourceType: "patient",
          resourceId: p.id,
          patientId: p.id,
          metadata: { permanent: true, bulk: true },
        });
      }

      res.json({
        message: `${deleteIds.length} patient(s) permanently deleted successfully`,
        deleteIds,
      });
    } catch (error) {
      console.error("Bulk permanent delete error:", error);
      res
        .status(500)
        .json({ message: "Failed to permanently delete patients" });
    }
  },
);

router.get(
  "/:id",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor", "nurse"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(
        req.params.id,
        req.user.clinicId,
        req.user.branchId,
      );
      if (!patient)
        return res.status(404).json({ message: "Patient not found" });

      res.json(toDecryptedPatient(patient));
    } catch (error) {
      console.error("Get patient error:", error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

router.post(
  "/",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor", "nurse"),
  validatePatient,
  async (req, res) => {
    try {
      const name = normalizeText(req.body?.name);
      const age = normalizeText(req.body?.age);
      const dateOfBirth = normalizeText(req.body?.dateOfBirth);
      const gender = normalizeText(req.body?.gender) || "other";
      const phone = normalizeText(req.body?.phone);
      const address = normalizeText(req.body?.address);
      const email = normalizeText(req.body?.email);
      const nextOfKinName = normalizeText(req.body?.nextOfKinName);
      const nextOfKinPhone = normalizeText(req.body?.nextOfKinPhone);
      const nextOfKinRelationship = normalizeText(
        req.body?.nextOfKinRelationship,
      );
      const nextOfKinAddress = normalizeText(req.body?.nextOfKinAddress);

      if (!name || !age) {
        return res.status(400).json({ message: "Name and age are required" });
      }

      if (!req.user.branchId) {
        return res.status(400).json({
          message:
            "No active branch selected. Please select a branch before creating a patient.",
        });
      }

      const patient = await createPatientWithGeneratedCardNumber({
        clinicId: req.user.clinicId,
        branchId: req.user.branchId,
        patientData: {
          name,
          age,
          dateOfBirth,
          gender,
          phone,
          address,
          email,
          nextOfKinName,
          nextOfKinPhone,
          nextOfKinRelationship,
          nextOfKinAddress,
        },
      });

      await logAuditEvent(req, {
        action: "patient.create",
        resourceType: "patient",
        resourceId: patient.id,
        patientId: patient.id,
        metadata: {
          gender: patient.gender,
          age: patient.age,
        },
      });

      res.status(201).json(toDecryptedPatient(patient));
    } catch (error) {
      console.error("Create patient error:", error);

      if (error instanceof Prisma.PrismaClientValidationError) {
        return res
          .status(400)
          .json({ message: "Invalid patient data submitted" });
      }

      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        const metaCause =
          typeof error.meta?.cause === "string" ? error.meta.cause : "";
        const message = metaCause || error.message;

        if (/column|field|relation|table/i.test(message)) {
          return res.status(500).json({
            message:
              "Patient creation failed because the database schema is out of date. Run the latest Prisma migration and restart the backend.",
          });
        }

        return res.status(500).json({ message: "Failed to create patient" });
      }

      res.status(500).json({
        message:
          process.env.NODE_ENV === "production"
            ? "Failed to create patient"
            : error.message || "Failed to create patient",
      });
    }
  },
);

router.post(
  "/import",
  protect,
  authorizeRoles("admin", "doctor", "nurse"),
  requireProOrEnterprise,
  async (req, res) => {
    try {
      const { patients } = req.body;

      if (!Array.isArray(patients) || patients.length === 0) {
        return res.status(400).json({ message: "No patients data provided" });
      }

      const validationErrors = [];
      const validPatientsData = [];

      patients.forEach((p, index) => {
        const rowNum = index + 1;
        const name = normalizeText(p.name);
        const age = normalizeText(p.age);

        if (!name && !age) {
          validationErrors.push(`Row ${rowNum}: Missing Name and Age`);
        } else if (!name) {
          validationErrors.push(`Row ${rowNum}: Missing Name`);
        } else if (!age) {
          validationErrors.push(`Row ${rowNum}: Missing Age`);
        } else {
          validPatientsData.push({
            name,
            age,
            gender: normalizeText(p.gender) || "other",
            phone: normalizeText(p.phone),
            address: normalizeText(p.address),
            email: normalizeText(p.email),
          });
        }
      });

      if (validationErrors.length > 0) {
        const displayErrors = validationErrors.slice(0, 5).join("; ");
        const moreCount = validationErrors.length - 5;
        const errorMessage = `Validation failed. ${displayErrors}${moreCount > 0 ? `... and ${moreCount} more errors` : ""}. Please fix your CSV and try again.`;
        return res.status(400).json({ message: errorMessage });
      }

      if (validPatientsData.length === 0) {
        return res
          .status(400)
          .json({ message: "No valid patient data found to import." });
      }

      let aggregate = await prisma.patient.aggregate({
        where: { clinicId: req.user.clinicId },
        _max: { cardNumberSequence: true },
      });

      let nextSequence = (aggregate._max.cardNumberSequence || 0) + 1;

      const newPatients = validPatientsData.map((p) => {
        const currentSeq = nextSequence++;

        return {
          clinicId: req.user.clinicId,
          branchId: req.user.branchId,
          cardNumberSequence: currentSeq,
          ...buildPatientSearchIndexData({
            name: p.name,
            age: p.age,
            cardNumber: formatCardNumber(currentSeq),
          }),
          ...toEncryptedPatientData({
            name: p.name,
            age: p.age,
            gender: p.gender,
            phone: p.phone,
            address: p.address,
            email: p.email,
            cardNumber: formatCardNumber(currentSeq),
          }),
        };
      });

      const created = await prisma.patient.createMany({
        data: newPatients,
        skipDuplicates: true,
      });

      await logAuditEvent(req, {
        action: "patient.create",
        resourceType: "patient",
        resourceId: "bulk_import",
        metadata: {
          importedCount: created.count,
        },
      });

      res.status(201).json({
        message: "Patients imported successfully",
        count: created.count,
      });
    } catch (error) {
      console.error("Import patients error:", error);
      res.status(500).json({ message: "Failed to bulk import patients" });
    }
  },
);

router.put(
  "/:id",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor", "nurse"),
  validatePatient,
  async (req, res) => {
    try {
      const existingPatient = await getPatientOr404(
        req.params.id,
        req.user.clinicId,
        req.user.branchId,
      );
      if (!existingPatient) {
        return res.status(404).json({ message: "Patient not found" });
      }

      const updates = {
        ...existingPatient,
        ...req.body,
      };

      const encryptedData = toEncryptedPatientData({
        name: updates.name,
        age: updates.age,
        dateOfBirth: updates.dateOfBirth,
        gender: updates.gender,
        phone: updates.phone,
        address: updates.address,
        email: updates.email,
        nextOfKinName: updates.nextOfKinName,
        nextOfKinPhone: updates.nextOfKinPhone,
        nextOfKinRelationship: updates.nextOfKinRelationship,
        nextOfKinAddress: updates.nextOfKinAddress,
      });
      const patientSearchIndexData = buildPatientSearchIndexData({
        name: updates.name,
        age: updates.age,
        cardNumber: toDecryptedPatient(existingPatient).cardNumber,
      });

      // Patient card numbers remain system-controlled after registration.
      // Retain the already-encrypted cardNumber to prevent double-encryption.
      encryptedData.cardNumber = existingPatient.cardNumber;

      const patient = await prisma.patient.update({
        where: { id: existingPatient.id },
        data: {
          ...encryptedData,
          ...patientSearchIndexData,
        },
      });

      await logAuditEvent(req, {
        action: "patient.update",
        resourceType: "patient",
        resourceId: patient.id,
        patientId: patient.id,
        metadata: {
          updatedFields: Object.keys(req.body),
        },
      });

      res.json(toDecryptedPatient(patient));
    } catch (error) {
      console.error("Update patient error:", error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

router.delete(
  "/:id",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor", "nurse"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(
        req.params.id,
        req.user.clinicId,
        req.user.branchId,
      );
      if (!patient)
        return res.status(404).json({ message: "Patient not found" });

      const updatedPatient = await prisma.patient.update({
        where: { id: patient.id },
        data: { isDeleted: true },
      });

      await logAuditEvent(req, {
        action: "patient.delete",
        resourceType: "patient",
        resourceId: patient.id,
        patientId: patient.id,
        metadata: { softDelete: true },
      });

      res.json({
        message: "Patient moved to Trash",
        patient: toDecryptedPatient(updatedPatient),
      });
    } catch (error) {
      console.error("Soft delete error:", error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

router.put(
  "/:id/restore",
  protect,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
      });

      if (
        !patient ||
        patient.clinicId !== req.user.clinicId ||
        patient.branchId !== req.user.branchId ||
        !patient.isDeleted
      ) {
        return res.status(404).json({ message: "Patient not found in Trash" });
      }

      const restoredPatient = await prisma.patient.update({
        where: { id: req.params.id },
        data: { isDeleted: false },
      });

      await logAuditEvent(req, {
        action: "patient.update",
        resourceType: "patient",
        resourceId: restoredPatient.id,
        patientId: restoredPatient.id,
        metadata: { restored: true },
      });

      res.json({
        message: "Patient restored successfully",
        patient: toDecryptedPatient(restoredPatient),
      });
    } catch (error) {
      console.error("Restore patient error:", error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

router.delete(
  "/:id/permanent",
  protect,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
      });
      if (
        !patient ||
        patient.clinicId !== req.user.clinicId ||
        patient.branchId !== req.user.branchId
      ) {
        return res.status(404).json({ message: "Patient not found" });
      }
      if (!patient.isDeleted) {
        return res.status(400).json({
          message:
            "Only patients already moved to Trash can be permanently deleted",
        });
      }

      await prisma.patient.delete({ where: { id: req.params.id } });

      await logAuditEvent(req, {
        action: "patient.delete",
        resourceType: "patient",
        resourceId: patient.id,
        patientId: patient.id,
        metadata: { permanent: true },
      });

      res.json({ message: "Patient permanently deleted" });
    } catch (error) {
      console.error("Permanent delete error:", error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

router.post(
  "/:id/records",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor"),
  upload.array("attachments"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(
        req.params.id,
        req.user.clinicId,
        req.user.branchId,
      );
      if (!patient)
        return res.status(404).json({ message: "Patient not found" });

      const {
        presentingComplaint,
        diagnosis,
        treatmentPlan,
        history,
        examination,
        examinationExtraOral,
        softTissue,
        periodontalStatus,
        occlusion,
        investigation,
        medication,
        allergies,
        comorbidities,
        currentMedication,
        dentition,
        teeth,
        consentObtained,
        consentDate,
        consentTakenBy,
        consentNotes,
        vitals,
      } = req.body;

      if (
        !presentingComplaint?.trim() ||
        !diagnosis?.trim() ||
        !treatmentPlan?.trim()
      ) {
        return res.status(400).json({
          message: "Complaint, diagnosis, and treatment plan are required",
        });
      }

      const normalizedConsent = normalizeConsentPayload({
        consentObtained,
        consentDate,
        consentTakenBy,
        consentNotes,
      });

      const uploadedAttachmentMetadata = normalizeAttachmentMetadataPayload(
        req.body.attachmentsMetadata,
      );
      const newFileAttachments = normalizeAttachments(
        req.files?.map((file) => ({
          name: getStoredAttachmentName(file),
          url: buildAttachmentUrl(patient.id, getStoredAttachmentName(file)),
          mimetype: file.mimetype,
        })),
      );
      const attachments = normalizeAttachments([
        ...uploadedAttachmentMetadata,
        ...newFileAttachments,
      ]);

      const record = await prisma.record.create({
        data: {
          patientId: patient.id,
          presentingComplaint,
          diagnosis,
          treatmentPlan,
          history: history || "",
          examination: buildExaminationSummary({
            examination,
            examinationExtraOral,
            softTissue,
            periodontalStatus,
            occlusion,
          }),
          examinationExtraOral: examinationExtraOral || "",
          softTissue: softTissue || "",
          periodontalStatus: periodontalStatus || "",
          occlusion: occlusion || "",
          investigation: investigation || "",
          medication: medication || "",
          allergies: allergies || "",
          comorbidities: comorbidities || "",
          currentMedication: currentMedication || "",
          ...normalizedConsent,
          dentition: normalizeDentition(dentition),
          teeth: normalizeTeeth(teeth),
          vitals: normalizeVitals(vitals),
          attachments,
        },
      });

      await logAuditEvent(req, {
        action: "record.create",
        resourceType: "record",
        resourceId: record.id,
        patientId: patient.id,
        metadata: {
          dentition: record.dentition,
          attachmentCount: attachments.length,
          consentObtained: record.consentObtained,
        },
      });

      res.status(201).json(serializeRecord(record));
    } catch (error) {
      console.error("Add record error:", error);
      res
        .status(500)
        .json({ message: error.message || "Failed to add patient record" });
    }
  },
);

router.put(
  "/:id/records/:recordId",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor"),
  upload.array("attachments"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(
        req.params.id,
        req.user.clinicId,
        req.user.branchId,
      );
      if (!patient)
        return res.status(404).json({ message: "Patient not found" });

      const record = await prisma.record.findUnique({
        where: { id: req.params.recordId },
      });

      if (!record || record.patientId !== patient.id) {
        return res
          .status(404)
          .json({ message: "Record not found for this patient" });
      }

      const {
        presentingComplaint,
        diagnosis,
        treatmentPlan,
        history,
        examination,
        examinationExtraOral,
        softTissue,
        periodontalStatus,
        occlusion,
        investigation,
        medication,
        allergies,
        comorbidities,
        currentMedication,
        dentition,
        teeth,
        removedAttachments,
        consentObtained,
        consentDate,
        consentTakenBy,
        consentNotes,
        vitals,
      } = req.body;

      const normalizedConsent = normalizeConsentPayload({
        consentObtained,
        consentDate,
        consentTakenBy,
        consentNotes,
      });

      const existingAttachments = normalizeAttachments(record.attachments);
      const removedNames = (
        removedAttachments
          ? Array.isArray(removedAttachments)
            ? removedAttachments
            : [removedAttachments]
          : []
      )
        .map((name) => path.basename(String(name || "")))
        .filter(Boolean);

      for (const name of removedNames) {
        try {
          await deleteObjectFromS3(`records/${name}`);
        } catch (err) {
          console.error("Failed to delete from S3:", err);
        }
        // Fallback for old local files
        const filePath = getLegacyRecordFilePath(name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }

      const retainedAttachments = existingAttachments.filter(
        (attachment) => !removedNames.includes(attachment?.name),
      );

      const uploadedAttachmentMetadata = normalizeAttachmentMetadataPayload(
        req.body.attachmentsMetadata,
      );
      const newFileAttachments = normalizeAttachments(
        req.files?.map((file) => ({
          name: getStoredAttachmentName(file),
          url: buildAttachmentUrl(patient.id, getStoredAttachmentName(file)),
          mimetype: file.mimetype,
        })),
      );
      const newAttachments = normalizeAttachments([
        ...uploadedAttachmentMetadata.filter(
          (attachment) =>
            !retainedAttachments.some(
              (retained) => retained?.name === attachment.name,
            ),
        ),
        ...newFileAttachments,
      ]);

      const updatedRecord = await prisma.record.update({
        where: { id: record.id },
        data: {
          presentingComplaint,
          diagnosis,
          treatmentPlan,
          history: history || "",
          examination: buildExaminationSummary({
            examination,
            examinationExtraOral,
            softTissue,
            periodontalStatus,
            occlusion,
          }),
          examinationExtraOral: examinationExtraOral || "",
          softTissue: softTissue || "",
          periodontalStatus: periodontalStatus || "",
          occlusion: occlusion || "",
          investigation: investigation || "",
          medication: medication || "",
          allergies: allergies || "",
          comorbidities: comorbidities || "",
          currentMedication: currentMedication || "",
          ...normalizedConsent,
          dentition: normalizeDentition(dentition),
          teeth: normalizeTeeth(teeth),
          vitals: normalizeVitals(vitals),
          attachments: [...retainedAttachments, ...newAttachments],
        },
      });

      await logAuditEvent(req, {
        action: "record.update",
        resourceType: "record",
        resourceId: updatedRecord.id,
        patientId: patient.id,
        metadata: {
          dentition: updatedRecord.dentition,
          removedAttachments: removedNames.length,
          addedAttachments: newAttachments.length,
          consentObtained: updatedRecord.consentObtained,
        },
      });

      res.json(serializeRecord(updatedRecord));
    } catch (error) {
      console.error("Update record error:", error);
      res
        .status(500)
        .json({ message: error.message || "Failed to update record" });
    }
  },
);

router.get(
  "/:id/records/attachments/:filename",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor", "nurse"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(
        req.params.id,
        req.user.clinicId,
        req.user.branchId,
      );
      if (!patient)
        return res.status(404).json({ message: "Patient not found" });

      const fileName = path.basename(req.params.filename);
      const candidateRecords = await prisma.record.findMany({
        where: { patientId: patient.id },
        select: { attachments: true },
      });

      const hasAttachment = candidateRecords.some((item) =>
        normalizeAttachments(item.attachments).some(
          (attachment) => attachment?.name === fileName,
        ),
      );

      if (!hasAttachment) {
        return res.status(404).json({ message: "Attachment not found" });
      }

      try {
        const url = await generatePresignedUrl(`records/${fileName}`);
        return res.redirect(url);
      } catch (err) {
        // Fallback to local files if S3 fails or file is not in S3
        const filePath = getLegacyRecordFilePath(fileName);
        if (fs.existsSync(filePath)) {
          return res.sendFile(filePath);
        }
        return res.status(404).json({ message: "Attachment file not found" });
      }
    } catch (error) {
      console.error("Get attachment error:", error);
      return res.status(500).json({ message: "Failed to fetch attachment" });
    }
  },
);

router.get(
  "/:id/records",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor", "nurse"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(
        req.params.id,
        req.user.clinicId,
        req.user.branchId,
      );
      if (!patient)
        return res.status(404).json({ message: "Patient not found" });

      const isTrash = req.query.trash === "true";
      const page = parsePositiveInteger(req.query.page, 1);
      const limit = Math.min(parsePositiveInteger(req.query.limit, 10), 50);
      const skip = (page - 1) * limit;
      const search = normalizeText(req.query.search).toLowerCase();
      const startDate = normalizeText(req.query.startDate);
      const endDate = normalizeText(req.query.endDate);
      const sortOption = normalizeRecordSortOption(req.query.sortOption);

      const where = {
        patientId: patient.id,
        isDeleted: isTrash,
        ...(search
          ? {
              OR: [
                {
                  presentingComplaint: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
                {
                  diagnosis: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
                {
                  history: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
              ],
            }
          : {}),
        ...(startDate || endDate
          ? {
              createdAt: {
                ...(startDate
                  ? {
                      gte: new Date(`${startDate}T00:00:00.000Z`),
                    }
                  : {}),
                ...(endDate
                  ? {
                      lte: new Date(`${endDate}T23:59:59.999Z`),
                    }
                  : {}),
              },
            }
          : {}),
      };

      const orderBy =
        sortOption === "oldest"
          ? [{ createdAt: "asc" }]
          : sortOption === "diagnosis"
            ? [{ diagnosis: "asc" }, { createdAt: "desc" }]
            : [{ createdAt: "desc" }];

      const [records, total] = await Promise.all([
        prisma.record.findMany({
          where,
          orderBy,
          skip,
          take: limit,
        }),
        prisma.record.count({ where }),
      ]);

      res.json({
        data: records.map(serializeRecord),
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (error) {
      console.error("Get records error:", error);
      res.status(500).json({ message: "Failed to fetch patient records" });
    }
  },
);

router.delete(
  "/:id/records/:recordId",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(
        req.params.id,
        req.user.clinicId,
        req.user.branchId,
      );
      if (!patient)
        return res.status(404).json({ message: "Patient not found" });

      const record = await prisma.record.findUnique({
        where: { id: req.params.recordId },
      });

      if (!record || record.patientId !== patient.id) {
        return res
          .status(404)
          .json({ message: "Record not found for this patient" });
      }

      await prisma.record.update({
        where: { id: record.id },
        data: { isDeleted: true, deletedAt: new Date() },
      });

      await logAuditEvent(req, {
        action: "record.delete",
        resourceType: "record",
        resourceId: record.id,
        patientId: patient.id,
        metadata: { softDelete: true },
      });

      res.json({ message: "Record moved to Trash" });
    } catch (error) {
      console.error("Soft delete record error:", error);
      res.status(500).json({ message: "Failed to delete record" });
    }
  },
);

router.patch(
  "/:id/records/:recordId/restore",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(
        req.params.id,
        req.user.clinicId,
        req.user.branchId,
      );
      if (!patient)
        return res.status(404).json({ message: "Patient not found" });

      const record = await prisma.record.findUnique({
        where: { id: req.params.recordId },
      });

      if (!record || record.patientId !== patient.id) {
        return res
          .status(404)
          .json({ message: "Record not found for this patient" });
      }

      const updatedRecord = await prisma.record.update({
        where: { id: req.params.recordId },
        data: { isDeleted: false, deletedAt: null },
      });

      await logAuditEvent(req, {
        action: "record.update",
        resourceType: "record",
        resourceId: updatedRecord.id,
        patientId: patient.id,
        metadata: { restored: true },
      });

      res.json(serializeRecord(updatedRecord));
    } catch (error) {
      console.error("Restore record error:", error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

router.delete(
  "/:id/records/:recordId/hard",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(
        req.params.id,
        req.user.clinicId,
        req.user.branchId,
      );
      if (!patient)
        return res.status(404).json({ message: "Patient not found" });

      const record = await prisma.record.findUnique({
        where: { id: req.params.recordId },
      });

      if (!record || record.patientId !== patient.id) {
        return res
          .status(404)
          .json({ message: "Record not found for this patient" });
      }

      if (!record.isDeleted) {
        return res.status(400).json({
          message: "Record must be in trash to be permanently deleted",
        });
      }

      for (const attachment of normalizeAttachments(record.attachments)) {
        try {
          await deleteObjectFromS3(`records/${attachment.name}`);
        } catch (err) {
          console.error("Failed to delete from S3:", err);
        }
        // Fallback for old local files
        const filePath = getLegacyRecordFilePath(attachment.name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }

      await prisma.record.delete({ where: { id: record.id } });

      await logAuditEvent(req, {
        action: "record.delete",
        resourceType: "record",
        resourceId: record.id,
        patientId: patient.id,
        metadata: {
          attachmentCount: normalizeAttachments(record.attachments).length,
        },
      });

      res.json({ message: "Record permanently deleted" });
    } catch (error) {
      console.error("Hard delete record error:", error);
      res.status(500).json({ message: "Failed to delete record" });
    }
  },
);

export default router;
