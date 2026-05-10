import express from "express";
import { prisma } from "../lib/prisma.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import { enforceSubscriptionState } from "../middleware/subscriptionStateGuard.js";

const router = express.Router();
router.use(protect);
router.use(enforceSubscriptionState({ allowAdminReadOnly: true }));

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
  authorizeRoles("admin", "branch_manager", "doctor", "nurse"),
  async (req, res) => {
    try {
      const clinicId = req.user.clinicId;
      const branchId = req.user.branchId;
      const { start: startOfDay, end: endOfDay } = getDayBounds();
      const { start: startOfMonth, end: endOfMonth } = getMonthBounds();

      const patientWhere = { clinicId, branchId, isDeleted: false };
      const trashWhere = { clinicId, branchId, isDeleted: true };
      const appointmentClinicWhere = {
        patient: { clinicId, isDeleted: false },
        OR: [
          { branchId: req.user.branchId },
          { branchId: null, patient: { branchId: req.user.branchId } }
        ],
      };
      const waitingClinicWhere = {
        patient: { clinicId, isDeleted: false },
        OR: [
          { branchId: req.user.branchId },
          { branchId: null, patient: { branchId: req.user.branchId } }
        ],
      };
      const invoiceClinicWhere = {
        patient: { clinicId },
        OR: [
          { branchId: req.user.branchId },
          { branchId: null, patient: { branchId: req.user.branchId } }
        ],
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
        waitingStatusGroups,
        totalWaiting,
        revenueAggregate,
        pendingIntakesCount,
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
            status: {
              notIn: ["cancelled", "completed"],
            },
          },
        }),
        prisma.appointment.count({
          where: {
            ...appointmentClinicWhere,
            status: "scheduled",
          },
        }),
        prisma.waitingRoom.groupBy({
          by: ["status"],
          where: waitingClinicWhere,
          _count: { _all: true },
        }),
        prisma.waitingRoom.count({ where: waitingClinicWhere }),
        prisma.invoice.aggregate({
          where: invoiceClinicWhere,
          _sum: {
            total: true,
          },
        }),
        prisma.pendingIntake.count({
          where: { clinicId, branchId, status: "pending" },
        }),
      ]);

      const getWaitingCount = (targetStatus) =>
        waitingStatusGroups.find((group) => group.status === targetStatus)?._count._all || 0;
      const waiting = getWaitingCount("waiting");
      const called = getWaitingCount("called");
      const inConsultation = getWaitingCount("in_consultation");
      const completed = getWaitingCount("completed");
      const activeWaiting = waiting + called;

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
        intakes: {
          pending: pendingIntakesCount,
        },
      });
    } catch (error) {
      require('fs').writeFileSync('dashboard-error.log', error.stack || error.message);
      console.error("Dashboard summary error:", error);
      return res.status(500).json({ message: "Failed to load dashboard summary" });
    }
  },
);

export default router;
