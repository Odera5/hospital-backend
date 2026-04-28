import { prisma } from "../lib/prisma.js";
import { logAuditEvent } from "../services/auditLog.js";
import { serializeWaitingEntry } from "../utils/serializers.js";
import { toDecryptedPatient } from "../utils/patientCrypto.js";

const STATUS_TIMES = {
  waiting: "arrivalTime",
  called: "calledAt",
  in_consultation: "consultationStartedAt",
  completed: "completedAt",
};
const waitingPatientSelect = {
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
};

const serializeWaitingResult = (entry) =>
  serializeWaitingEntry({
    ...entry,
    patientId: toDecryptedPatient(entry.patient),
  });

const getDayBounds = (value = new Date()) => {
  const startOfDay = new Date(value);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(value);
  endOfDay.setHours(23, 59, 59, 999);

  return { startOfDay, endOfDay };
};

export const getWaitingList = async (req, res) => {
  try {
    const { status, search } = req.query;

    const items = await prisma.waitingRoom.findMany({
      where: {
        patient: { clinicId: req.user.clinicId, isDeleted: false },
        ...(status ? { status } : {}),
        ...(search
          ? {
              patientName: {
                contains: search,
                mode: "insensitive",
              },
            }
          : {}),
      },
      include: {
        patient: {
          select: waitingPatientSelect,
        },
      },
      orderBy: [{ arrivalTime: "asc" }],
    });

    res.json(items.map(serializeWaitingResult));
  } catch (error) {
    console.error("Get waiting list error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const getWaitingSummary = async (req, res) => {
  try {
    const baseWhere = {
      patient: { clinicId: req.user.clinicId, isDeleted: false },
    };

    const [statusGroups, total] = await Promise.all([
      prisma.waitingRoom.groupBy({
        by: ["status"],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.waitingRoom.count({ where: baseWhere }),
    ]);

    const getStatusCount = (targetStatus) =>
      statusGroups.find((group) => group.status === targetStatus)?._count._all || 0;

    res.json({
      waiting: getStatusCount("waiting"),
      called: getStatusCount("called"),
      in_consultation: getStatusCount("in_consultation"),
      completed: getStatusCount("completed"),
      total,
    });
  } catch (error) {
    console.error("Get waiting summary error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const createWaitingEntry = async (req, res) => {
  try {
    const { patientId, notes } = req.body;
    if (!patientId) {
      return res.status(400).json({ message: "Patient ID is required" });
    }

    const patient = await prisma.patient.findFirst({
      where: { id: patientId, clinicId: req.user.clinicId },
    });
    if (!patient || patient.isDeleted) {
      return res.status(404).json({ message: "Patient not found" });
    }

    const existing = await prisma.waitingRoom.findFirst({
      where: {
        patientId,
        status: {
          in: ["waiting", "called", "in_consultation"],
        },
      },
    });

    if (existing) {
      return res
        .status(400)
        .json({ message: "Patient is already in the waiting room" });
    }

    const decryptedPatient = toDecryptedPatient(patient);
    const { startOfDay, endOfDay } = getDayBounds();

    const [item, updatedAppointments] = await prisma.$transaction([
      prisma.waitingRoom.create({
        data: {
          patientId,
          patientName: decryptedPatient.name,
          notes: notes?.trim() || "",
        },
        include: {
          patient: {
            select: waitingPatientSelect,
          },
        },
      }),
      prisma.appointment.updateMany({
        where: {
          patientId,
          status: "scheduled",
          appointmentDate: {
            gte: startOfDay,
            lte: endOfDay,
          },
        },
        data: {
          status: "arrived",
        },
      }),
    ]);

    await logAuditEvent(req, {
      action: "waiting_room.create",
      resourceType: "waiting_room",
      resourceId: item.id,
      patientId,
      metadata: {
        status: item.status,
        checkedInAppointments: updatedAppointments.count,
      },
    });

    res.status(201).json(serializeWaitingResult(item));
  } catch (error) {
    console.error("Create waiting entry error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const updateWaitingEntry = async (req, res) => {
  try {
    const { status, notes } = req.body;
    const item = await prisma.waitingRoom.findUnique({
      where: { id: req.params.id },
      include: {
        patient: {
          select: waitingPatientSelect,
        },
      },
    });

    if (!item || item.patient.clinicId !== req.user.clinicId) {
      return res.status(404).json({ message: "Queue item not found" });
    }

    const updateData = {};
    if (status && status !== item.status) {
      if (
        req.user.role === "nurse" &&
        !(
          item.status === "waiting" &&
          status === "called"
        )
      ) {
        return res.status(403).json({
          message: "Front desk can only move patients from Waiting to Called",
        });
      }

      updateData.status = status;
      const field = STATUS_TIMES[status];
      if (field) updateData[field] = new Date();
    }
    if (notes !== undefined) updateData.notes = notes;

    const updatedItem = await prisma.waitingRoom.update({
      where: { id: item.id },
      data: updateData,
      include: {
        patient: {
          select: waitingPatientSelect,
        },
      },
    });

    await logAuditEvent(req, {
      action: "waiting_room.update",
      resourceType: "waiting_room",
      resourceId: updatedItem.id,
      patientId: updatedItem.patientId,
      metadata: {
        status: updatedItem.status,
        notesUpdated: notes !== undefined,
      },
    });

    res.json(serializeWaitingResult(updatedItem));
  } catch (error) {
    console.error("Update waiting entry error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const deleteWaitingEntry = async (req, res) => {
  try {
    const item = await prisma.waitingRoom.findUnique({
      where: { id: req.params.id },
      include: {
        patient: {
          select: { clinicId: true },
        },
      },
    });
    if (!item || item.patient?.clinicId !== req.user.clinicId) {
      return res.status(404).json({ message: "Queue item not found" });
    }

    await prisma.waitingRoom.delete({ where: { id: item.id } });
    await logAuditEvent(req, {
      action: "waiting_room.delete",
      resourceType: "waiting_room",
      resourceId: item.id,
      patientId: item.patientId,
      metadata: { status: item.status },
    });

    res.json({ message: "Waiting room entry removed" });
  } catch (error) {
    console.error("Delete waiting entry error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};
