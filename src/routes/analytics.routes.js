import express from "express";
import { prisma } from "../lib/prisma.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import { requireProOrEnterprise } from "../middleware/subscriptionGuard.js";

const router = express.Router();

router.get("/dashboard", protect, authorizeRoles("admin", "doctor"), requireProOrEnterprise, async (req, res) => {
  try {
    const clinicId = req.user.clinicId;

    // 1. Appointments Data (Completed vs No-Show vs Scheduled vs Cancelled)
    const appointmentStatusCounts = await prisma.appointment.groupBy({
      by: ['status'],
      where: {
        patient: { clinicId }
      },
      _count: {
        id: true
      }
    });

    // 2. Demographics (Age Group Approximation based on average or counts, simplify to total patients)
    // To make it fun for demographics, let's just count gender
    const genderDemographics = await prisma.patient.groupBy({
        by: ['gender'],
        where: { clinicId, isDeleted: false },
        _count: { id: true }
    });

    // 3. Simple Revenue (Monthly for last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const invoices = await prisma.invoice.findMany({
      where: {
        patient: { clinicId },
        status: "paid",
        invoiceDate: { gte: sixMonthsAgo }
      },
      select: {
         total: true,
         invoiceDate: true
      }
    });

    // Aggregate monthly revenue manually (SQLite/Postgres differences make group-by-date tricky in Prisma)
    const revenueByMonthMap = {};
    invoices.forEach(inv => {
      const month = inv.invoiceDate.toLocaleString('default', { month: 'short' });
      revenueByMonthMap[month] = (revenueByMonthMap[month] || 0) + inv.total;
    });
    
    // Sort logic to ensure past 6 months are ordered correctly
    const months = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        months.push(d.toLocaleString('default', { month: 'short' }));
    }

    const revenueByMonth = months.map(m => ({
        month: m,
        revenue: revenueByMonthMap[m] || 0
    }));

    res.json({
      appointments: appointmentStatusCounts.map(a => ({ status: a.status, count: a._count.id })),
      demographics: genderDemographics.map(g => ({ gender: g.gender, count: g._count.id })),
      revenueByMonth
    });

  } catch (error) {
    console.error("Analytics Error:", error);
    res.status(500).json({ message: "Failed to generate analytics report." });
  }
});

export default router;
