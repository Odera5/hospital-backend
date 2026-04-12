import { prisma } from "../lib/prisma.js";
import { serializeAppointment } from "../utils/serializers.js";
import { toDecryptedPatient } from "../utils/patientCrypto.js";

const WORKING_HOURS = [
  "09:00",
  "09:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "14:00",
  "14:30",
  "15:00",
  "15:30",
  "16:00",
  "16:30",
];

const SLOT_MINUTES = 30;

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

const parseTimeSlotToMinutes = (value) => {
  if (typeof value !== "string" || !value.includes(":")) return null;

  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;

  return hours * 60 + minutes;
};

const rangesOverlap = (startA, endA, startB, endB) =>
  startA < endB && startB < endA;

const getAppointmentRange = (timeSlot, duration = SLOT_MINUTES) => {
  const start = parseTimeSlotToMinutes(timeSlot);
  if (start === null) return null;

  const safeDuration = Math.max(SLOT_MINUTES, Number(duration) || SLOT_MINUTES);
  return {
    start,
    end: start + safeDuration,
  };
};

const isSlotAvailableForDuration = (slot, duration, appointments, excludedId = null) => {
  const candidateRange = getAppointmentRange(slot, duration);
  if (!candidateRange) return false;

  const workingDayStart = parseTimeSlotToMinutes(WORKING_HOURS[0]);
  const workingDayEnd =
    parseTimeSlotToMinutes(WORKING_HOURS[WORKING_HOURS.length - 1]) + SLOT_MINUTES;

  if (
    candidateRange.start < workingDayStart ||
    candidateRange.end > workingDayEnd
  ) {
    return false;
  }

  return !appointments.some((appointment) => {
    if (excludedId && appointment.id === excludedId) return false;
    if (appointment.status === "cancelled") return false;

    const existingRange = getAppointmentRange(
      appointment.timeSlot,
      appointment.duration,
    );

    if (!existingRange) return false;

    return rangesOverlap(
      candidateRange.start,
      candidateRange.end,
      existingRange.start,
      existingRange.end,
    );
  });
};

const listAvailableSlots = (appointments, duration, excludedId = null) =>
  WORKING_HOURS.filter((slot) =>
    isSlotAvailableForDuration(slot, duration, appointments, excludedId),
  );

export const getAllAppointments = async (req, res) => {
  try {
    const {
      patientId,
      dentistId,
      status,
      startDate,
      endDate,
      excludeStatuses,
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

    const appointments = await prisma.appointment.findMany({
      where,
      include: {
        patient: true,
        dentist: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: { appointmentDate: "asc" },
    });

    res.json(
      appointments.map((appointment) =>
        serializeAppointment({
          ...appointment,
          patientId: toDecryptedPatient(appointment.patient),
          dentistId: appointment.dentist,
        }),
      ),
    );
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
        patient: { clinicId: req.user.clinicId, isDeleted: false },
      },
      include: {
        patient: true,
        dentist: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
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
        notes: notes || "",
        duration: Number(duration) || 30,
      },
      include: {
        patient: true,
        dentist: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
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
    } = req.body;

    const appointment = await prisma.appointment.findUnique({
      where: { id: req.params.id },
      include: { patient: true },
    });

    if (!appointment || appointment.patient.clinicId !== req.user.clinicId) {
      return res.status(404).json({ message: "Appointment not found" });
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
      },
      include: {
        patient: true,
        dentist: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
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
          select: { clinicId: true },
        },
      },
    });

    if (!appointment || appointment.patient?.clinicId !== req.user.clinicId) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    await prisma.appointment.delete({
      where: { id: appointment.id },
    });

    res.json({ message: "Appointment cancelled" });
  } catch (error) {
    console.error("Delete appointment error:", error.message);
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
        patient: { clinicId: req.user.clinicId, isDeleted: false },
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
