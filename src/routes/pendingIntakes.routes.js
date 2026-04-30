import express from "express";
import { Prisma } from "@prisma/client";
import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import { toEncryptedPatientData } from "../utils/patientCrypto.js";
import {
  SLOT_MINUTES,
  getAppointmentStartDateTime,
  isSlotAvailableForDuration,
} from "../utils/appointmentScheduling.js";

const router = express.Router();

const formatCardNumber = (sequence) => `P-${String(sequence).padStart(6, "0")}`;

const isPatientCardSequenceConflict = (error) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  Array.isArray(error.meta?.target) &&
  error.meta.target.includes("clinicId") &&
  error.meta.target.includes("cardNumberSequence");

const createAppointmentResponseToken = () =>
  crypto.randomBytes(24).toString("hex");

const ACTIVE_PAYSTACK_STATUSES = ["active", "attention", "success"];

const clinicHasReminderAccess = (clinic) => {
  if (!clinic || clinic.plan !== "PRO") return false;

  const hasActivePaidSubscription = ACTIVE_PAYSTACK_STATUSES.includes(
    String(clinic.paystackSubscriptionStatus || "").toLowerCase(),
  );

  if (
    clinic.subscriptionEnds &&
    new Date(clinic.subscriptionEnds) < new Date() &&
    !hasActivePaidSubscription
  ) {
    return false;
  }

  return true;
};

const isResendConfigured = () =>
  Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim());

const isMailConfigured = () =>
  Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_PORT?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim() &&
      process.env.SMTP_FROM_EMAIL?.trim(),
  );

const isEmailConfigured = () => isResendConfigured() || isMailConfigured();

const isSmsConfigured = () =>
  Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
      process.env.TWILIO_AUTH_TOKEN?.trim() &&
      (process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() ||
        process.env.TWILIO_PHONE_NUMBER?.trim()),
  );

const isLikelyE164PhoneNumber = (value) =>
  /^\+[1-9]\d{7,14}$/.test(String(value || "").trim());

const buildReminderUpdate = ({
  clinic,
  patientEmail,
  patientPhone,
  appointmentDate,
  timeSlot,
}) => {
  const hasReminderAccess = clinicHasReminderAccess(clinic);
  const appointmentStart = getAppointmentStartDateTime(appointmentDate, timeSlot);
  const normalizedPatientEmail = String(patientEmail || "").trim();
  const normalizedPatientPhone = String(patientPhone || "").trim();
  const hasPatientEmail = Boolean(normalizedPatientEmail);
  const hasValidPatientPhone = isLikelyE164PhoneNumber(normalizedPatientPhone);
  const hasReachableContact =
    (isEmailConfigured() && hasPatientEmail) ||
    (isSmsConfigured() && hasValidPatientPhone);
  const canScheduleReminder =
    hasReminderAccess &&
    hasReachableContact &&
    appointmentStart &&
    appointmentStart > new Date();

  return {
    reminderEnabled: canScheduleReminder,
    reminderStatus: canScheduleReminder
      ? "scheduled"
      : !hasReminderAccess
        ? "plan_locked"
        : !hasReachableContact && hasPatientEmail
          ? "no_phone"
          : !hasReachableContact
            ? "no_contact"
            : "disabled",
    reminderLastError: canScheduleReminder
      ? ""
      : !hasReminderAccess
        ? "Automated reminders require an active Pro plan or trial."
        : !hasReachableContact
          ? "Patient phone number or email is required for automated reminders."
          : "",
  };
};

// GET /api/pending-intakes - Fetch pending intakes for the clinic
router.get("/", protect, authorizeRoles("admin", "doctor", "nurse"), async (req, res) => {
  try {
    const intakes = await prisma.pendingIntake.findMany({
      where: {
        clinicId: req.user.clinicId,
        status: "pending"
      },
      orderBy: {
        createdAt: "desc"
      }
    });

    res.json(intakes);
  } catch (error) {
    console.error("Fetch pending intakes error:", error);
    res.status(500).json({ message: "Failed to fetch pending intakes" });
  }
});

// POST /api/pending-intakes/:id/approve - Approve a pending intake
router.post("/:id/approve", protect, authorizeRoles("admin", "doctor", "nurse"), async (req, res) => {
  try {
    const { id } = req.params;
    const clinicId = req.user.clinicId;
    const assignedDate = String(req.body?.assignedDate || "").trim();
    const assignedTime = String(req.body?.assignedTime || "").trim();

    if ((assignedDate && !assignedTime) || (!assignedDate && assignedTime)) {
      return res.status(400).json({
        message: "Assigned appointment date and time must be provided together.",
      });
    }

    let result = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        result = await prisma.$transaction(async (tx) => {
          const pendingIntake = await tx.pendingIntake.findUnique({
            where: { id },
            include: {
              clinic: {
                select: {
                  id: true,
                  plan: true,
                  subscriptionEnds: true,
                  paystackSubscriptionStatus: true,
                },
              },
            },
          });

          if (
            !pendingIntake ||
            pendingIntake.clinicId !== clinicId ||
            pendingIntake.status !== "pending"
          ) {
            const error = new Error("Pending intake not found or already processed.");
            error.statusCode = 404;
            throw error;
          }

          const aggregate = await tx.patient.aggregate({
            where: { clinicId },
            _max: { cardNumberSequence: true },
          });

          const nextSequence = (aggregate._max.cardNumberSequence || 0) + 1;

          const createdPatient = await tx.patient.create({
            data: {
              clinicId,
              cardNumberSequence: nextSequence,
              ...toEncryptedPatientData({
                name: pendingIntake.name,
                age: pendingIntake.age,
                gender: pendingIntake.gender,
                phone: pendingIntake.phone,
                address: pendingIntake.address,
                email: pendingIntake.email,
                cardNumber: formatCardNumber(nextSequence),
              }),
            },
          });

          let createdAppointment = null;

          if (assignedDate && assignedTime) {
            const appointmentDay = new Date(assignedDate);
            if (Number.isNaN(appointmentDay.getTime())) {
              const error = new Error("Assigned appointment date is invalid.");
              error.statusCode = 400;
              throw error;
            }

            const startOfDay = new Date(appointmentDay);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(appointmentDay);
            endOfDay.setHours(23, 59, 59, 999);

            const dayAppointments = await tx.appointment.findMany({
              where: {
                patient: { clinicId, isDeleted: false },
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

            if (
              !isSlotAvailableForDuration(
                assignedTime,
                SLOT_MINUTES,
                dayAppointments,
              )
            ) {
              const error = new Error(
                "That appointment time is no longer available. Please choose another slot.",
              );
              error.statusCode = 400;
              throw error;
            }

            const reminderUpdate = buildReminderUpdate({
              clinic: pendingIntake.clinic,
              patientEmail: pendingIntake.email,
              patientPhone: pendingIntake.phone,
              appointmentDate: assignedDate,
              timeSlot: assignedTime,
            });

            createdAppointment = await tx.appointment.create({
              data: {
                patientId: createdPatient.id,
                appointmentDate: new Date(assignedDate),
                timeSlot: assignedTime,
                appointmentType: "checkup",
                status: "scheduled",
                notes: "Booked via online intake form.",
                patientResponseToken: createAppointmentResponseToken(),
                ...reminderUpdate,
              },
            });
          }

          await tx.pendingIntake.update({
            where: { id },
            data: { status: "approved" },
          });

          return {
            patient: createdPatient,
            appointment: createdAppointment,
          };
        });
        break;
      } catch (error) {
        if (isPatientCardSequenceConflict(error) && attempt < 4) {
          continue;
        }
        throw error;
      }
    }

    if (!result?.patient) {
      throw new Error("Failed to approve intake request.");
    }

    res.status(200).json({
      message: "Patient registered successfully",
      patient: result.patient,
      appointment: result.appointment,
    });
  } catch (error) {
    console.error("Approve pending intake error:", error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Failed to approve intake request. Please try again.",
    });
  }
});

// DELETE /api/pending-intakes/:id - Reject a pending intake
router.delete("/:id", protect, authorizeRoles("admin", "doctor", "nurse"), async (req, res) => {
  try {
    const { id } = req.params;
    const clinicId = req.user.clinicId;

    const pendingIntake = await prisma.pendingIntake.findUnique({
      where: { id }
    });

    if (!pendingIntake || pendingIntake.clinicId !== clinicId || pendingIntake.status !== "pending") {
      return res.status(404).json({ message: "Pending intake not found or already processed." });
    }

    await prisma.pendingIntake.update({
      where: { id },
      data: { status: "rejected" }
    });

    res.status(200).json({ message: "Intake request rejected successfully" });
  } catch (error) {
    console.error("Reject pending intake error:", error);
    res.status(500).json({ message: "Failed to reject intake request." });
  }
});

export default router;
