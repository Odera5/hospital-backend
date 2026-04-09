import { prisma } from "../lib/prisma.js";
import { serializeAppointment } from "../utils/serializers.js";
import { toDecryptedPatient } from "../utils/patientCrypto.js";

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
        patient: { clinicId: req.user.clinicId },
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

    const existing = await prisma.appointment.findFirst({
      where: {
        patient: { clinicId: req.user.clinicId },
        appointmentDate: {
          gte: startOfDay,
          lte: endOfDay,
        },
        timeSlot,
        status: { not: "cancelled" },
      },
    });

    if (existing) {
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

      const existing = await prisma.appointment.findFirst({
        where: {
          id: { not: appointment.id },
          patient: { clinicId: req.user.clinicId },
          appointmentDate: {
            gte: startOfDay,
            lte: endOfDay,
          },
          timeSlot,
          status: { not: "cancelled" },
        },
      });

      if (existing) {
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
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ message: "Date required" });
    }

    const workingHours = [
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

    const day = new Date(date);
    const startOfDay = new Date(day);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(day);
    endOfDay.setHours(23, 59, 59, 999);

    const booked = await prisma.appointment.findMany({
      where: {
        patient: { clinicId: req.user.clinicId },
        appointmentDate: {
          gte: startOfDay,
          lte: endOfDay,
        },
        status: { not: "cancelled" },
      },
      select: { timeSlot: true },
    });

    const bookedSlots = booked.map((appointment) => appointment.timeSlot);
    const availableSlots = workingHours.filter(
      (slot) => !bookedSlots.includes(slot),
    );

    res.json({ availableSlots, date });
  } catch (error) {
    console.error("Get available slots error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};
