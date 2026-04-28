import express from "express";
import { prisma } from "../lib/prisma.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";

const router = express.Router();

const getDayBounds = (value = new Date()) => {
  const start = new Date(value);
  start.setHours(0, 0, 0, 0);

  const end = new Date(value);
  end.setHours(23, 59, 59, 999);

  return { start, end };
};

const getMonthBounds = (value = new Date()) => {
  const start = new Date(value.getFullYear(), value.getMonth(), 1);
  const end = new Date(value.getFullYear(), value.getMonth() + 1, 0);
  end.setHours(23, 59, 59, 999);

  return { start, end };
};

router.get(
  "/summary",
  protect,
  authorizeRoles("admin", "doctor", "nurse"),
  async (req, res) => {
    try {
      const clinicId = req.user.clinicId;
      const { start: startOfDay, end: endOfDay } = getDayBounds();
      const { start: startOfMonth, end: endOfMonth } = getMonthBounds();

      const patientWhere = { clinicId, isDeleted: false };
      const trashWhere = { clinicId, isDeleted: true };
      const appointmentClinicWhere = {
        patient: { clinicId, isDeleted: false },
      };
      const waitingClinicWhere = {
        patient: { clinicId, isDeleted: false },
      };
      const invoiceClinicWhere = {
        patient: { clinicId },
        status: { not: "draft" },
        invoiceDate: {
          gte: startOfMonth,
          lte: endOfMonth,
        },
      };

      const [
        activePatients,
        patientsToday,
        trashCount,
        appointmentsToday,
        scheduledAppointments,
        waiting,
        called,
        inConsultation,
        completed,
        totalWaiting,
        activeWaiting,
        revenueAggregate,
      ] = await Promise.all([
        prisma.patient.count({ where: patientWhere }),
        prisma.patient.count({
          where: {
            ...patientWhere,
            createdAt: {
              gte: startOfDay,
              lte: endOfDay,
            },
          },
        }),
        prisma.patient.count({ where: trashWhere }),
        prisma.appointment.count({
          where: {
            ...appointmentClinicWhere,
            appointmentDate: {
              gte: startOfDay,
              lte: endOfDay,
            },
          },
        }),
        prisma.appointment.count({
          where: {
            ...appointmentClinicWhere,
            status: "scheduled",
          },
        }),
        prisma.waitingRoom.count({
          where: {
            ...waitingClinicWhere,
            status: "waiting",
          },
        }),
        prisma.waitingRoom.count({
          where: {
            ...waitingClinicWhere,
            status: "called",
          },
        }),
        prisma.waitingRoom.count({
          where: {
            ...waitingClinicWhere,
            status: "in_consultation",
          },
        }),
        prisma.waitingRoom.count({
          where: {
            ...waitingClinicWhere,
            status: "completed",
          },
        }),
        prisma.waitingRoom.count({ where: waitingClinicWhere }),
        prisma.waitingRoom.count({
          where: {
            ...waitingClinicWhere,
            status: { in: ["waiting", "called"] },
          },
        }),
        prisma.invoice.aggregate({
          where: invoiceClinicWhere,
          _sum: {
            total: true,
          },
        }),
      ]);

      return res.json({
        patients: {
          active: activePatients,
          today: patientsToday,
          trash: trashCount,
        },
        appointments: {
          today: appointmentsToday,
          scheduled: scheduledAppointments,
        },
        waitingRoom: {
          waiting,
          called,
          in_consultation: inConsultation,
          completed,
          total: totalWaiting,
          active: activeWaiting,
        },
        billing: {
          monthlyRevenue: revenueAggregate._sum.total || 0,
        },
      });
    } catch (error) {
      console.error("Dashboard summary error:", error.message);
      return res.status(500).json({ message: "Failed to load dashboard summary" });
    }
  },
);

export default router;
