import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import { logAuditEvent } from "../services/auditLog.js";
import { serializeAppointment } from "../utils/serializers.js";
import { toDecryptedPatient } from "../utils/patientCrypto.js";
import {
  hasReminderAccess,
  getReminderAccessRequiredMessage,
} from "../utils/subscriptionAccess.js";
import {
  SLOT_MINUTES,
  getAppointmentStartDateTime,
  isSlotAvailableForDuration,
  listAvailableSlots,
} from "../utils/appointmentScheduling.js";
import { sendBookingConfirmationEmail } from "../services/appointmentReminderService.js";
const appointmentPatientSelect = {
  id: true,
  clinicId: true,
  branchId: true,
  isDeleted: true,
  name: true,
  cardNumber: true,
  age: true,
  email: true,
  gender: true,
  phone: true,
  address: true,
};
const dentistSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
};

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseReminderEnabled = (value) =>
  value === true || String(value || "").toLowerCase() === "true";

const buildDateFilter = (startDate, endDate) => {
  if (!startDate && !endDate) return undefined;

  const filter = {};
  if (startDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    filter.gte = start;
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    filter.lte = end;
  }
  return filter;
};

const getReminderPlanError = () =>
  getReminderAccessRequiredMessage();

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

const getReminderContactError = () => {
  if (isEmailConfigured() && isSmsConfigured()) {
    return "Patient phone number or email is required before automated reminders can be sent.";
  }

  if (isEmailConfigured()) {
    return "Patient email is required before automated reminders can be sent.";
  }

  if (isSmsConfigured()) {
    return "Patient phone number is required before automated reminders can be sent.";
  }

  return "Reminder delivery is not configured yet.";
};

const getReminderInvalidPhoneError = () =>
  "Patient phone number must be in international format, for example +2348012345678.";

const isLikelyE164PhoneNumber = (value) =>
  /^\+[1-9]\d{7,14}$/.test(String(value || "").trim());

const createAppointmentResponseToken = () =>
  crypto.randomBytes(24).toString("hex");

const buildReminderUpdate = ({
  requestedReminderEnabled,
  clinic,
  patientEmail,
  patientPhone,
  appointmentDate,
  timeSlot,
  nextStatus = "scheduled",
  resetSchedule = false,
}) => {
  const hasClinicReminderAccess = hasReminderAccess(clinic);
  const appointmentStart = getAppointmentStartDateTime(appointmentDate, timeSlot);
  const normalizedPatientEmail = String(patientEmail || "").trim();
  const normalizedPatientPhone = String(patientPhone || "").trim();
  const hasPatientEmail = Boolean(normalizedPatientEmail);
  const hasPatientPhone = Boolean(normalizedPatientPhone);
  const hasValidPatientPhone = isLikelyE164PhoneNumber(normalizedPatientPhone);
  const canUseEmail = isEmailConfigured() && hasPatientEmail;
  const canUseSms = isSmsConfigured() && hasValidPatientPhone;
  const needsOnlyEmail = isEmailConfigured() && !isSmsConfigured();
  const needsOnlySms = !isEmailConfigured() && isSmsConfigured();
  const hasReachableContact = canUseEmail || canUseSms;
  const canScheduleReminder =
    Boolean(requestedReminderEnabled) &&
    nextStatus === "scheduled" &&
    hasClinicReminderAccess &&
    hasReachableContact &&
    appointmentStart &&
    appointmentStart > new Date();

  const update = {
    reminderEnabled: canScheduleReminder,
    reminderStatus: canScheduleReminder
      ? "scheduled"
      : nextStatus !== "scheduled"
        ? "disabled"
        : requestedReminderEnabled && !hasClinicReminderAccess
          ? "plan_locked"
          : requestedReminderEnabled && !hasReachableContact && needsOnlyEmail
            ? "no_email"
          : requestedReminderEnabled && !hasReachableContact && needsOnlySms && !hasPatientPhone
            ? "no_phone"
          : requestedReminderEnabled && !hasReachableContact && needsOnlySms && hasPatientPhone && !hasValidPatientPhone
            ? "invalid_phone"
          : requestedReminderEnabled && !hasReachableContact && !hasPatientEmail && !hasPatientPhone
            ? "no_contact"
          : requestedReminderEnabled && !hasReachableContact && !hasPatientEmail && hasPatientPhone && !hasValidPatientPhone
            ? "invalid_phone"
          : requestedReminderEnabled && !hasReachableContact && !hasPatientEmail && !hasValidPatientPhone
            ? "no_contact"
            : requestedReminderEnabled && !hasReachableContact && hasPatientPhone && !hasValidPatientPhone
              ? "invalid_phone"
            : "disabled",
    reminderLastError: canScheduleReminder
      ? ""
      : requestedReminderEnabled && !hasClinicReminderAccess
        ? getReminderPlanError()
        : requestedReminderEnabled && !hasReachableContact && needsOnlyEmail
          ? getReminderContactError()
          : requestedReminderEnabled && !hasReachableContact && needsOnlySms && !hasPatientPhone
            ? getReminderContactError()
          : requestedReminderEnabled && !hasReachableContact && needsOnlySms && hasPatientPhone && !hasValidPatientPhone
            ? getReminderInvalidPhoneError()
          : requestedReminderEnabled && !hasReachableContact && !hasPatientEmail && !hasPatientPhone
          ? getReminderContactError()
          : requestedReminderEnabled && !hasReachableContact && !hasPatientEmail && hasPatientPhone && !hasValidPatientPhone
            ? getReminderInvalidPhoneError()
          : requestedReminderEnabled && !hasReachableContact && !hasPatientEmail && !hasValidPatientPhone
            ? getReminderContactError()
          : requestedReminderEnabled && !hasReachableContact && hasPatientPhone && !hasValidPatientPhone
            ? getReminderInvalidPhoneError()
          : "",
  };

  if (resetSchedule) {
    update.reminderLastSentAt = null;
    update.remindersSent = [];
  }

  return update;
};

const buildConfirmationUpdate = ({
  currentStatus = "pending",
  reset = false,
}) => ({
  patientConfirmationStatus: reset ? "pending" : currentStatus || "pending",
  patientConfirmationRespondedAt: reset ? null : undefined,
  patientRequestedRescheduleDate: reset ? null : undefined,
  patientRequestedRescheduleTime: reset ? null : undefined,
  patientRequestedRescheduleNote: reset ? "" : undefined,
  patientRequestedRescheduleAt: reset ? null : undefined,
});

const getPatientResponseLockedMessage = (confirmationStatus) => {
  if (confirmationStatus === "confirmed") {
    return "This appointment has already been confirmed.";
  }

  if (confirmationStatus === "reschedule_requested") {
    return "A reschedule request has already been sent for this appointment.";
  }

  return "This appointment response link has already been used.";
};

export const getAllAppointments = async (req, res) => {
  try {
    const {
      patientId,
      dentistId,
      status,
      startDate,
      endDate,
      excludeStatuses,
      page: pageParam,
      limit: limitParam,
    } = req.query;

    const parsedExcludedStatuses = excludeStatuses
      ? excludeStatuses
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];

    const where = {
      patient: {
        clinicId: req.user.clinicId,
        isDeleted: false,
      },
      OR: [
        { branchId: req.user.branchId },
        { branchId: null, patient: { branchId: req.user.branchId } }
      ],
      ...(patientId ? { patientId } : {}),
      ...(dentistId ? { dentistId, dentist: { clinicId: req.user.clinicId } } : {}),
      ...(buildDateFilter(startDate, endDate)
        ? { appointmentDate: buildDateFilter(startDate, endDate) }
        : {}),
    };

    if (status) {
      where.status = status;
    } else if (parsedExcludedStatuses.length) {
      where.status = { notIn: parsedExcludedStatuses };
    }

    const shouldPaginate =
      pageParam !== undefined || limitParam !== undefined;

    if (!shouldPaginate) {
      const appointments = await prisma.appointment.findMany({
        where,
        include: {
          patient: {
            select: appointmentPatientSelect,
          },
          dentist: {
            select: dentistSelect,
          },
        },
        orderBy: [{ appointmentDate: "asc" }, { timeSlot: "asc" }],
      });

      return res.json(
        appointments.map((appointment) =>
          serializeAppointment({
            ...appointment,
            patientId: toDecryptedPatient(appointment.patient),
            dentistId: appointment.dentist,
          }),
        ),
      );
    }

    const page = parsePositiveInteger(pageParam, 1);
    const limit = Math.min(parsePositiveInteger(limitParam, 24), 100);
    const skip = (page - 1) * limit;

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        include: {
          patient: {
            select: appointmentPatientSelect,
          },
          dentist: {
            select: dentistSelect,
          },
        },
        orderBy: [{ appointmentDate: "asc" }, { timeSlot: "asc" }],
        skip,
        take: limit,
      }),
      prisma.appointment.count({ where }),
    ]);

    return res.json({
      data: appointments.map((appointment) =>
        serializeAppointment({
          ...appointment,
          patientId: toDecryptedPatient(appointment.patient),
          dentistId: appointment.dentist,
        }),
      ),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("Get appointments error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const getAppointment = async (req, res) => {
  try {
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: req.params.id,
        patient: {
          clinicId: req.user.clinicId,
          isDeleted: false,
        },
        OR: [
          { branchId: req.user.branchId },
          { branchId: null, patient: { branchId: req.user.branchId } }
        ],
      },
      include: {
        patient: {
          select: appointmentPatientSelect,
        },
        dentist: {
          select: dentistSelect,
        },
      },
    });

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    res.json(
      serializeAppointment({
        ...appointment,
        patientId: toDecryptedPatient(appointment.patient),
        dentistId: appointment.dentist,
      }),
    );
  } catch (error) {
    console.error("Get appointment error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const createAppointment = async (req, res) => {
  try {
    const {
      patientId,
      appointmentDate,
      timeSlot,
      appointmentType,
      dentistId,
      notes,
      duration,
      reminderEnabled,
    } = req.body;

    if (!patientId || !appointmentDate || !timeSlot) {
      return res
        .status(400)
        .json({ message: "Patient ID, date, and time slot required" });
    }

    const patient = await prisma.patient.findFirst({
      where: { id: patientId, clinicId: req.user.clinicId },
    });
    if (!patient || patient.isDeleted) {
      return res.status(404).json({ message: "Patient not found" });
    }

    const clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
      select: {
        id: true,
        name: true,
        plan: true,
        subscriptionEnds: true,
        paystackSubscriptionStatus: true,
      },
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    if (dentistId) {
      const dentist = await prisma.user.findFirst({
        where: {
          id: dentistId,
          clinicId: req.user.clinicId,
          isActive: true,
        },
      });

      if (!dentist) {
        return res.status(404).json({ message: "Staff member not found for this clinic" });
      }
    }

    const appointmentDay = new Date(appointmentDate);
    const startOfDay = new Date(appointmentDay);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(appointmentDay);
    endOfDay.setHours(23, 59, 59, 999);

    const dayAppointments = await prisma.appointment.findMany({
      where: {
        patient: { clinicId: req.user.clinicId, isDeleted: false },
        OR: [
          { branchId: req.user.branchId },
          { branchId: null, patient: { branchId: req.user.branchId } }
        ],
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
        timeSlot,
        Number(duration) || SLOT_MINUTES,
        dayAppointments,
      )
    ) {
      return res.status(400).json({ message: "Time slot already booked" });
    }

    const appointment = await prisma.appointment.create({
      data: {
        patientId,
        appointmentDate: new Date(appointmentDate),
        timeSlot,
        appointmentType: appointmentType || "checkup",
        dentistId: dentistId || null,
        branchId: req.user.branchId,
        notes: notes || "",
        duration: Number(duration) || 30,
        patientResponseToken: createAppointmentResponseToken(),
        ...buildConfirmationUpdate({ reset: true }),
        ...buildReminderUpdate({
          requestedReminderEnabled: parseReminderEnabled(reminderEnabled),
          clinic,
          patientEmail: toDecryptedPatient(patient)?.email,
          patientPhone: toDecryptedPatient(patient)?.phone,
          appointmentDate,
          timeSlot,
          nextStatus: "scheduled",
          resetSchedule: true,
        }),
      },
      include: {
        patient: {
          select: appointmentPatientSelect,
        },
        dentist: {
          select: dentistSelect,
        },
      },
    });

    if (isEmailConfigured()) {
      const decryptedPatient = toDecryptedPatient(appointment.patient);
      if (decryptedPatient?.email) {
        sendBookingConfirmationEmail({
          email: decryptedPatient.email,
          patientName: decryptedPatient.name,
          clinicName: clinic?.name,
          appointmentDate: appointment.appointmentDate,
          timeSlot: appointment.timeSlot,
          responseToken: appointment.patientResponseToken,
        }).catch((err) => {
          console.error("Failed to send booking confirmation email:", err);
        });
      }
    }

    await logAuditEvent(req, {
      action: "appointment.create",
      resourceType: "appointment",
      resourceId: appointment.id,
      patientId: appointment.patientId,
      metadata: {
        appointmentDate: appointment.appointmentDate,
        timeSlot: appointment.timeSlot,
        appointmentType: appointment.appointmentType,
      },
    });

    res.status(201).json(
      serializeAppointment({
        ...appointment,
        patientId: toDecryptedPatient(appointment.patient),
        dentistId: appointment.dentist,
      }),
    );
  } catch (error) {
    console.error("Create appointment error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const updateAppointment = async (req, res) => {
  try {
    const {
      appointmentDate,
      timeSlot,
      appointmentType,
      status,
      notes,
      dentistId,
      duration,
      reminderEnabled,
    } = req.body;

    const appointment = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: { patient: true },
    });

    if (!appointment || appointment.patient.clinicId !== req.user.clinicId || (appointment.branchId !== req.user.branchId && (appointment.branchId !== null || appointment.patient.branchId !== req.user.branchId))) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    const clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
      select: {
        id: true,
        name: true,
        plan: true,
        subscriptionEnds: true,
        paystackSubscriptionStatus: true,
      },
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    if (req.user.role === "nurse" && status === "completed") {
      return res.status(403).json({
        message: "Front desk cannot mark appointments as completed",
      });
    }

    if (dentistId) {
      const dentist = await prisma.user.findFirst({
        where: {
          id: dentistId,
          clinicId: req.user.clinicId,
          isActive: true,
        },
      });

      if (!dentist) {
        return res.status(404).json({ message: "Staff member not found for this clinic" });
      }
    }

    const isClosedAppointment = [
      "arrived",
      "completed",
      "cancelled",
      "no_show",
    ].includes(appointment.status);
    const isTryingToReopen =
      appointment.status === "completed" &&
      status &&
      status !== "completed";

    if (isTryingToReopen) {
      return res.status(400).json({
        message:
          "Completed appointments are closed. Create a new appointment when the patient needs another visit.",
      });
    }

    if (
      isClosedAppointment &&
      (appointmentDate ||
        timeSlot ||
        appointmentType ||
        dentistId !== undefined ||
        duration ||
        notes !== undefined)
    ) {
      return res.status(400).json({
        message:
          "Closed appointments cannot be edited. Create a new appointment for a future visit.",
      });
    }

    if (appointmentDate && timeSlot) {
      const day = new Date(appointmentDate);
      const startOfDay = new Date(day);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(day);
      endOfDay.setHours(23, 59, 59, 999);

      const dayAppointments = await prisma.appointment.findMany({
        where: {
          patient: { clinicId: req.user.clinicId, isDeleted: false },
          OR: [
            { branchId: req.user.branchId },
            { branchId: null, patient: { branchId: req.user.branchId } }
          ],
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
          timeSlot,
          Number(duration) || appointment.duration || SLOT_MINUTES,
          dayAppointments,
          appointment.id,
        )
      ) {
        return res.status(400).json({ message: "Time slot already booked" });
      }
    }

    const nextAppointmentDate = appointmentDate || appointment.appointmentDate;
    const nextTimeSlot = timeSlot || appointment.timeSlot;
    const nextStatus = status || appointment.status;
    const shouldReevaluateReminder =
      reminderEnabled !== undefined ||
      Boolean(appointmentDate) ||
      Boolean(timeSlot) ||
      Boolean(status);
    const shouldResetPatientConfirmation =
      Boolean(appointmentDate) ||
      Boolean(timeSlot) ||
      appointmentType !== undefined ||
      duration !== undefined;
    const nextReminderPreference =
      reminderEnabled !== undefined
        ? parseReminderEnabled(reminderEnabled)
        : appointment.reminderEnabled;

    const reminderUpdate = shouldReevaluateReminder
        ? buildReminderUpdate({
          requestedReminderEnabled: nextReminderPreference,
          clinic,
          patientEmail: toDecryptedPatient(appointment.patient)?.email,
          patientPhone: toDecryptedPatient(appointment.patient)?.phone,
          appointmentDate: nextAppointmentDate,
          timeSlot: nextTimeSlot,
          nextStatus,
          resetSchedule:
            reminderEnabled !== undefined ||
            Boolean(appointmentDate) ||
            Boolean(timeSlot) ||
            nextStatus !== appointment.status,
        })
      : {};

    const updatedAppointment = await prisma.appointment.update({
      where: { id: appointment.id },
      data: {
        ...(appointmentDate ? { appointmentDate: new Date(appointmentDate) } : {}),
        ...(timeSlot ? { timeSlot } : {}),
        ...(appointmentType ? { appointmentType } : {}),
        ...(status ? { status } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(dentistId !== undefined ? { dentistId: dentistId || null } : {}),
        ...(duration ? { duration: Number(duration) } : {}),
        ...(shouldResetPatientConfirmation
          ? buildConfirmationUpdate({ reset: true })
          : {}),
        ...reminderUpdate,
      },
      include: {
        patient: {
          select: appointmentPatientSelect,
        },
        dentist: {
          select: dentistSelect,
        },
      },
    });

    await logAuditEvent(req, {
      action: "appointment.update",
      resourceType: "appointment",
      resourceId: updatedAppointment.id,
      patientId: updatedAppointment.patientId,
      metadata: {
        updatedFields: Object.keys(req.body),
      },
    });

    res.json(
      serializeAppointment({
        ...updatedAppointment,
        patientId: toDecryptedPatient(updatedAppointment.patient),
        dentistId: updatedAppointment.dentist,
      }),
    );
  } catch (error) {
    console.error("Update appointment error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const deleteAppointment = async (req, res) => {
  try {
    const appointment = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: {
        patient: {
          select: { clinicId: true, branchId: true },
        },
      },
    });

    if (!appointment || appointment.patient?.clinicId !== req.user.clinicId || (appointment.branchId !== req.user.branchId && (appointment.branchId !== null || appointment.patient?.branchId !== req.user.branchId))) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    await prisma.appointment.delete({
      where: { id: appointment.id },
    });

    await logAuditEvent(req, {
      action: "appointment.delete",
      resourceType: "appointment",
      resourceId: appointment.id,
      patientId: appointment.patientId,
      metadata: {
        appointmentDate: appointment.appointmentDate,
        timeSlot: appointment.timeSlot,
      },
    });

    res.json({ message: "Appointment cancelled" });
  } catch (error) {
    console.error("Delete appointment error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const respondToAppointment = async (req, res) => {
  try {
    const token = String(req.body?.token || req.query?.token || "").trim();
    const action = String(req.body?.action || req.query?.action || "").trim().toLowerCase();
    const preferredDate = String(
      req.body?.preferredDate || req.query?.preferredDate || "",
    ).trim();
    const preferredTime = String(
      req.body?.preferredTime || req.query?.preferredTime || "",
    ).trim();
    const preferredNote = String(
      req.body?.preferredNote || req.query?.preferredNote || "",
    ).trim();

    if (!token) {
      return res.status(400).json({ message: "Response token is required" });
    }

    if (!["confirm", "reschedule"].includes(action)) {
      return res.status(400).json({ message: "Invalid response action" });
    }

    let normalizedPreferredDate = null;

    if (action === "reschedule") {
      if (!preferredDate || !preferredTime) {
        return res.status(400).json({
          message:
            "Please select your preferred new date and time before submitting this reschedule request.",
        });
      }

      normalizedPreferredDate = new Date(preferredDate);
      if (Number.isNaN(normalizedPreferredDate.getTime())) {
        return res.status(400).json({
          message: "Preferred reschedule date is invalid.",
        });
      }

      normalizedPreferredDate.setHours(0, 0, 0, 0);
    }

    const appointment = await prisma.appointment.findUnique({
      where: { patientResponseToken: token },
      include: {
        patient: {
          select: {
            id: true,
            clinicId: true,
            isDeleted: true,
            name: true,
            cardNumber: true,
            age: true,
            email: true,
            gender: true,
            phone: true,
            address: true,
            clinic: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        dentist: {
          select: dentistSelect,
        },
      },
    });

    if (!appointment || appointment.patient?.isDeleted) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    if (appointment.patientConfirmationStatus !== "pending") {
      return res.status(400).json({
        message: getPatientResponseLockedMessage(
          appointment.patientConfirmationStatus,
        ),
      });
    }

    if (appointment.status !== "scheduled") {
      return res.status(400).json({
        message: "This appointment is no longer open for patient confirmation.",
      });
    }

    const appointmentStart = getAppointmentStartDateTime(
      appointment.appointmentDate,
      appointment.timeSlot,
    );

    if (!appointmentStart || appointmentStart <= new Date()) {
      return res.status(400).json({
        message: "This appointment is no longer open for patient confirmation.",
      });
    }

    const nextConfirmationStatus =
      action === "confirm" ? "confirmed" : "reschedule_requested";
    const respondedAt = new Date();

    const updateResult = await prisma.appointment.updateMany({
      where: {
        id: appointment.id,
        status: "scheduled",
        patientConfirmationStatus: "pending",
      },
      data: {
        patientConfirmationStatus: nextConfirmationStatus,
        patientConfirmationRespondedAt: respondedAt,
        patientRequestedRescheduleDate:
          action === "reschedule" ? normalizedPreferredDate : null,
        patientRequestedRescheduleTime:
          action === "reschedule" ? preferredTime : null,
        patientRequestedRescheduleNote:
          action === "reschedule" ? preferredNote.slice(0, 500) : "",
        patientRequestedRescheduleAt:
          action === "reschedule" ? respondedAt : null,
        ...(action === "reschedule"
          ? {
              reminderEnabled: false,
              reminderStatus: "disabled",
              reminderLastError: "",
            }
          : {}),
      },
    });

    if (updateResult.count === 0) {
      const latestAppointment = await prisma.appointment.findUnique({
        where: { id: appointment.id },
        select: {
          status: true,
          patientConfirmationStatus: true,
        },
      });

      if (latestAppointment?.patientConfirmationStatus !== "pending") {
        return res.status(400).json({
          message: getPatientResponseLockedMessage(
            latestAppointment?.patientConfirmationStatus,
          ),
        });
      }

      return res.status(400).json({
        message: "This appointment is no longer open for patient confirmation.",
      });
    }

    const updatedAppointment = await prisma.appointment.findUnique({
      where: { id: appointment.id },
      include: {
        patient: {
          select: appointmentPatientSelect,
        },
        dentist: {
          select: dentistSelect,
        },
      },
    });

    await logAuditEvent(req, {
      action: "appointment.update",
      resourceType: "appointment",
      resourceId: updatedAppointment.id,
      patientId: updatedAppointment.patientId,
      metadata: {
        patientResponse: nextConfirmationStatus,
        action,
      },
    });

    return res.json({
      message:
        action === "confirm"
          ? "Appointment confirmed successfully."
          : "Reschedule request received successfully.",
      appointment: serializeAppointment({
        ...updatedAppointment,
        patientId: toDecryptedPatient(updatedAppointment.patient),
        dentistId: updatedAppointment.dentist,
      }),
    });
  } catch (error) {
    console.error("Respond to appointment error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const getAvailableSlots = async (req, res) => {
  try {
    const { date, duration, appointmentId } = req.query;

    if (!date) {
      return res.status(400).json({ message: "Date required" });
    }

    const day = new Date(date);
    const startOfDay = new Date(day);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(day);
    endOfDay.setHours(23, 59, 59, 999);

    const booked = await prisma.appointment.findMany({
      where: {
        patient: { clinicId: req.user.clinicId, branchId: req.user.branchId, isDeleted: false },
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
      appointmentId || null,
    );

    res.json({ availableSlots, date });
  } catch (error) {
    console.error("Get available slots error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};
