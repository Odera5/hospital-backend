import express from "express";
import rateLimit from "express-rate-limit";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { toEncryptedPatientData } from "../utils/patientCrypto.js";
import { SLOT_MINUTES, listAvailableSlots } from "../utils/appointmentScheduling.js";
import {
  hasActiveProAccess,
  getUpgradeRequiredMessage,
} from "../utils/subscriptionAccess.js";
import { validatePublicIntake } from "../middleware/validators.js";

const router = express.Router();

const normalizeText = (value) => (typeof value === "string" ? value.trim() : "");
const formatCardNumber = (sequence) => `P-${String(sequence).padStart(6, "0")}`;

const isPatientCardSequenceConflict = (error) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  Array.isArray(error.meta?.target) &&
  error.meta.target.includes("clinicId") &&
  error.meta.target.includes("cardNumberSequence");

const intakeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 intake submissions per window
  message: { message: "Too many intake submissions from this IP. Please try again later." }
});

const intakeAccessClinicSelect = {
  id: true,
  name: true,
  logoUrl: true,
  brandColor: true,
  plan: true,
  address: true,
  phone: true,
  intakeEnabled: true,
  intakePublicToken: true,
  subscriptionEnds: true,
  paystackSubscriptionStatus: true,
};

const getActiveBranchForIntake = async ({ clinicId, branchId = "", accessToken = "" }) =>
  prisma.branch.findFirst({
    where: {
      clinicId,
      ...(branchId
        ? { id: branchId }
        : accessToken
          ? { intakePublicToken: accessToken }
          : {}),
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      city: true,
      area: true,
      intakeEnabled: true,
      intakePublicToken: true,
    },
  });

const validateIntakeAccess = (clinic, branch, accessToken) => {
  if (!clinic) {
    return "Clinic not found";
  }

  if (!hasActiveProAccess(clinic)) {
    return getUpgradeRequiredMessage();
  }

  if (!branch) {
    return "This patient intake link is invalid or has been revoked.";
  }

  if (!branch.intakeEnabled) {
    return "This branch has not enabled patient intake access right now.";
  }

  if (!branch.intakePublicToken || !accessToken || accessToken !== branch.intakePublicToken) {
    return "This patient intake link is invalid or has been revoked.";
  }

  return null;
};

// GET /api/intake/:clinicId - Fetch public details of a clinic for the Intake Form UI
router.get("/:clinicId", async (req, res) => {
  try {
    const { clinicId } = req.params;
    const accessToken = String(req.query?.access || "").trim();
    const requestedBranchId = String(req.query?.branchId || "").trim();
    
    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: intakeAccessClinicSelect,
    });

    const branch = await getActiveBranchForIntake({
      clinicId,
      branchId: requestedBranchId,
      accessToken,
    });

    const accessError = validateIntakeAccess(clinic, branch, accessToken);
    if (accessError) {
      return res.status(clinic ? 403 : 404).json({ message: accessError });
    }

    const { intakePublicToken, ...publicClinic } = clinic;
    res.json({
      ...publicClinic,
      branch: {
        id: branch.id,
        name: branch.name,
        city: branch.city,
        area: branch.area,
      },
    });
  } catch (error) {
    console.error("Intake Fetch Error:", error);
    res.status(500).json({ message: "Failed to fetch clinic details" });
  }
});

// GET /api/intake/:clinicId/available-slots - Fetch public available slots for a clinic
router.get("/:clinicId/available-slots", async (req, res) => {
  try {
    const { clinicId } = req.params;
    const { date, duration } = req.query;
    const accessToken = String(req.query?.access || "").trim();
    const requestedBranchId = String(req.query?.branchId || "").trim();

    if (!date) {
      return res.status(400).json({ message: "Date required" });
    }

    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: intakeAccessClinicSelect,
    });

    const branch = await getActiveBranchForIntake({
      clinicId,
      branchId: requestedBranchId,
      accessToken,
    });

    const accessError = validateIntakeAccess(clinic, branch, accessToken);
    if (accessError) {
      return res.status(clinic ? 403 : 404).json({ message: accessError });
    }

    const day = new Date(date);
    const startOfDay = new Date(day);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(day);
    endOfDay.setHours(23, 59, 59, 999);

    const booked = await prisma.appointment.findMany({
      where: {
        patient: { clinicId, branchId: branch.id, isDeleted: false },
        appointmentDate: {
          gte: startOfDay,
          lte: endOfDay,
        },
        status: { not: "cancelled" },
      },
      select: {
        id: true,
        timeSlot: true,
        duration: true,
        status: true,
      },
    });

    const availableSlots = listAvailableSlots(
      booked,
      Number(duration) || SLOT_MINUTES,
    );

    res.json({ availableSlots, date });
  } catch (error) {
    console.error("Intake available slots error:", error);
    res.status(500).json({ message: "Failed to fetch available appointment slots" });
  }
});

// POST /api/intake/:clinicId - Submit a new patient
router.post("/:clinicId", intakeLimiter, validatePublicIntake, async (req, res) => {
  try {
    const { clinicId } = req.params;

    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: intakeAccessClinicSelect,
    });

    const accessToken = String(req.query?.access || req.body?.access || "").trim();
    const requestedBranchId = String(req.query?.branchId || req.body?.branchId || "").trim();
    const branch = await getActiveBranchForIntake({
      clinicId,
      branchId: requestedBranchId,
      accessToken,
    });

    const accessError = validateIntakeAccess(clinic, branch, accessToken);
    if (accessError) {
      return res.status(clinic ? 403 : 404).json({ message: accessError });
    }

    const name = normalizeText(req.body?.name);
    const age = normalizeText(req.body?.age);
    const gender = normalizeText(req.body?.gender) || "other";
    const phone = normalizeText(req.body?.phone);
    const address = normalizeText(req.body?.address);
    const email = normalizeText(req.body?.email);
    const preferredDate = req.body?.preferredDate ? new Date(req.body.preferredDate) : null;
    const preferredTime = normalizeText(req.body?.preferredTime);

    if (!name || !age) {
      return res.status(400).json({ message: "Name and age are required" });
    }

    const pendingIntake = await prisma.pendingIntake.create({
      data: {
        clinicId,
        branchId: branch.id,
        name,
        age,
        gender,
        phone,
        email,
        address,
        preferredDate,
        preferredTime,
        status: "pending"
      }
    });

    res.status(201).json({ message: "Intake form submitted successfully. Your request is pending approval." });
  } catch (error) {
    console.error("Intake submission error:", error);
    res.status(500).json({ message: "Failed to submit intake form. Please try again." });
  }
});

export default router;
