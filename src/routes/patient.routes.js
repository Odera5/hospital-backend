import express from "express";
import fs from "fs";
import path from "path";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import upload from "../middleware/upload.js";
import { logAuditEvent } from "../services/auditLog.js";
import {
  toDecryptedPatient,
  toEncryptedPatientData,
} from "../utils/patientCrypto.js";
import { serializeRecord } from "../utils/serializers.js";

const router = express.Router();

const normalizeText = (value) => (typeof value === "string" ? value.trim() : "");

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

  return parsed
    .map((tooth) => ({
      number: Number(tooth?.number),
      condition:
        typeof tooth?.condition === "string" ? tooth.condition : "present",
    }))
    .filter(
      (tooth) =>
        Number.isFinite(tooth.number) &&
        ["present", "carious", "tender", "mobile", "fractured", "missing"].includes(
          tooth.condition,
        ),
    );
};

const normalizeAttachments = (attachments) =>
  Array.isArray(attachments) ? attachments : [];

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

const formatCardNumber = (sequence) => `PAT-${String(sequence).padStart(6, "0")}`;

const isPatientCardSequenceConflict = (error) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  Array.isArray(error.meta?.target) &&
  error.meta.target.includes("clinicId") &&
  error.meta.target.includes("cardNumberSequence");

const createPatientWithGeneratedCardNumber = async ({
  clinicId,
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
          cardNumberSequence: nextSequence,
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

const getPatientOr404 = async (id, clinicId) => {
  const patient = await prisma.patient.findFirst({ where: { id, clinicId } });
  if (!patient || patient.isDeleted) return null;
  return patient;
};

router.get(
  "/",
  protect,
  authorizeRoles("admin", "doctor", "nurse"),
  async (req, res) => {
    try {
      const patients = await prisma.patient.findMany({
        where: { clinicId: req.user.clinicId, isDeleted: false },
        orderBy: { createdAt: "desc" },
      });

      res.json(patients.map(toDecryptedPatient));
    } catch (error) {
      console.error("Get patients error:", error);
      res.status(500).json({ message: "Failed to fetch patients" });
    }
  },
);

router.get(
  "/trash/all",
  protect,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const trash = await prisma.patient.findMany({
        where: { clinicId: req.user.clinicId, isDeleted: true },
        orderBy: { createdAt: "desc" },
      });

      res.json(trash.map(toDecryptedPatient));
    } catch (error) {
      console.error("Get trash error:", error);
      res.status(500).json({ message: "Failed to fetch trash" });
    }
  },
);

router.get(
  "/:id",
  protect,
  authorizeRoles("admin", "doctor", "nurse"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(req.params.id, req.user.clinicId);
      if (!patient) return res.status(404).json({ message: "Patient not found" });

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
  authorizeRoles("admin", "doctor", "nurse"),
  async (req, res) => {
    try {
      const name = normalizeText(req.body?.name);
      const age = normalizeText(req.body?.age);
      const gender = normalizeText(req.body?.gender) || "other";
      const phone = normalizeText(req.body?.phone);
      const address = normalizeText(req.body?.address);
      const email = normalizeText(req.body?.email);

      if (!name || !age) {
        return res.status(400).json({ message: "Name and age are required" });
      }

      const patient = await createPatientWithGeneratedCardNumber({
        clinicId: req.user.clinicId,
        patientData: {
          name,
          age,
          gender,
          phone,
          address,
          email,
        },
      });

      res.status(201).json(toDecryptedPatient(patient));
    } catch (error) {
      console.error("Create patient error:", error);

      if (error instanceof Prisma.PrismaClientValidationError) {
        return res.status(400).json({ message: "Invalid patient data submitted" });
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

router.put(
  "/:id",
  protect,
  authorizeRoles("admin", "doctor"),
  async (req, res) => {
    try {
      const existingPatient = await getPatientOr404(req.params.id, req.user.clinicId);
      if (!existingPatient) {
        return res.status(404).json({ message: "Patient not found" });
      }

      const updates = {
        ...existingPatient,
        ...req.body,
      };

      const patient = await prisma.patient.update({
        where: { id: existingPatient.id },
        data: {
          ...toEncryptedPatientData({
            name: updates.name,
            // Patient card numbers remain system-controlled after registration.
            cardNumber: existingPatient.cardNumber,
            age: updates.age,
            gender: updates.gender,
            phone: updates.phone,
            address: updates.address,
            email: updates.email,
          }),
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
  authorizeRoles("admin", "doctor", "nurse"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(req.params.id, req.user.clinicId);
      if (!patient) return res.status(404).json({ message: "Patient not found" });

      const updatedPatient = await prisma.patient.update({
        where: { id: patient.id },
        data: { isDeleted: true },
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
        !patient.isDeleted
      ) {
        return res.status(404).json({ message: "Patient not found in Trash" });
      }

      const restoredPatient = await prisma.patient.update({
        where: { id: req.params.id },
        data: { isDeleted: false },
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
      if (!patient || patient.clinicId !== req.user.clinicId) {
        return res.status(404).json({ message: "Patient not found" });
      }
      if (!patient.isDeleted) {
        return res.status(400).json({
          message: "Only patients already moved to Trash can be permanently deleted",
        });
      }

      await prisma.patient.delete({ where: { id: req.params.id } });
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
  authorizeRoles("admin", "doctor"),
  upload.array("attachments"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(req.params.id, req.user.clinicId);
      if (!patient) return res.status(404).json({ message: "Patient not found" });

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
        dentition,
        teeth,
        consentObtained,
        consentDate,
        consentTakenBy,
        consentNotes,
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

      const attachments = normalizeAttachments(
        req.files?.map((file) => ({
          name: file.filename,
          url: buildAttachmentUrl(patient.id, file.filename),
          mimetype: file.mimetype,
        })),
      );

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
          ...normalizedConsent,
          dentition: dentition === "child" ? "child" : "adult",
          teeth: normalizeTeeth(teeth),
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
  authorizeRoles("admin", "doctor"),
  upload.array("attachments"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(req.params.id, req.user.clinicId);
      if (!patient) return res.status(404).json({ message: "Patient not found" });

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
        dentition,
        teeth,
        removedAttachments,
        consentObtained,
        consentDate,
        consentTakenBy,
        consentNotes,
      } = req.body;

      const normalizedConsent = normalizeConsentPayload({
        consentObtained,
        consentDate,
        consentTakenBy,
        consentNotes,
      });

      const existingAttachments = normalizeAttachments(record.attachments);
      const removedNames = removedAttachments
        ? Array.isArray(removedAttachments)
          ? removedAttachments
          : [removedAttachments]
        : [];

      removedNames.forEach((name) => {
        const filePath = path.join("uploads", "records", name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });

      const retainedAttachments = existingAttachments.filter(
        (attachment) => !removedNames.includes(attachment?.name),
      );

      const newAttachments = normalizeAttachments(
        req.files?.map((file) => ({
          name: file.filename,
          url: buildAttachmentUrl(patient.id, file.filename),
          mimetype: file.mimetype,
        })),
      );

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
          ...normalizedConsent,
          dentition: dentition === "child" ? "child" : "adult",
          teeth: normalizeTeeth(teeth),
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
      res.status(500).json({ message: error.message || "Failed to update record" });
    }
  },
);

router.get(
  "/:id/records/attachments/:filename",
  protect,
  authorizeRoles("admin", "doctor", "nurse"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(req.params.id, req.user.clinicId);
      if (!patient) return res.status(404).json({ message: "Patient not found" });

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

      const filePath = path.join(process.cwd(), "uploads", "records", fileName);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: "Attachment file not found" });
      }

      return res.sendFile(filePath);
    } catch (error) {
      console.error("Get attachment error:", error);
      return res.status(500).json({ message: "Failed to fetch attachment" });
    }
  },
);

router.get(
  "/:id/records",
  protect,
  authorizeRoles("admin", "doctor", "nurse"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(req.params.id, req.user.clinicId);
      if (!patient) return res.status(404).json({ message: "Patient not found" });

      const records = await prisma.record.findMany({
        where: { patientId: patient.id },
        orderBy: { createdAt: "desc" },
      });

      res.json(records.map(serializeRecord));
    } catch (error) {
      console.error("Get records error:", error);
      res.status(500).json({ message: "Failed to fetch patient records" });
    }
  },
);

router.delete(
  "/:id/records/:recordId",
  protect,
  authorizeRoles("admin", "doctor"),
  async (req, res) => {
    try {
      const patient = await getPatientOr404(req.params.id, req.user.clinicId);
      if (!patient) return res.status(404).json({ message: "Patient not found" });

      const record = await prisma.record.findUnique({
        where: { id: req.params.recordId },
      });

      if (!record || record.patientId !== patient.id) {
        return res
          .status(404)
          .json({ message: "Record not found for this patient" });
      }

      normalizeAttachments(record.attachments).forEach((attachment) => {
        const filePath = path.join("uploads", "records", attachment.name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });

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

      res.json({ message: "Record deleted successfully" });
    } catch (error) {
      console.error("Delete record error:", error);
      res.status(500).json({ message: "Failed to delete record" });
    }
  },
);

export default router;
