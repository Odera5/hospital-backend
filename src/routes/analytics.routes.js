import express from "express";
import { prisma } from "../lib/prisma.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import { requireProOrEnterprise } from "../middleware/subscriptionGuard.js";
import { enforceSubscriptionState } from "../middleware/subscriptionStateGuard.js";
import { autoUpdateOverdueInvoices } from "../controllers/invoiceController.js";

const router = express.Router();
router.use(protect);
router.use(enforceSubscriptionState({ allowAdminReadOnly: true }));
router.use(autoUpdateOverdueInvoices);

router.get("/dashboard", protect, authorizeRoles("admin", "branch_manager", "doctor"), requireProOrEnterprise, async (req, res) => {
  try {
    const clinicId = req.user.clinicId;
    const branchId = req.user.branchId;
    const { startDate, endDate } = req.query;

    let dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) {
       const end = new Date(endDate);
       end.setHours(23, 59, 59, 999);
       dateFilter.lte = end;
    }

    // 1. Appointments Data (Completed vs No-Show vs Scheduled vs Cancelled)
    const appointmentStatusCounts = await prisma.appointment.groupBy({
      by: ['status'],
      where: {
        patient: { clinicId, branchId },
        ...(Object.keys(dateFilter).length > 0 && { appointmentDate: dateFilter })
      },
      _count: {
        id: true
      }
    });

    // 2. Demographics (Age Group Approximation based on average or counts, simplify to total patients)
    // To make it fun for demographics, let's just count gender
    const genderDemographics = await prisma.patient.groupBy({
        by: ['gender'],
        where: { 
          clinicId,
          branchId,
          isDeleted: false,
          ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter })
        },
        _count: { id: true }
    });

    // 3. Simple Revenue
    let invoiceDateFilter = { ...dateFilter };
    if (!startDate && !endDate) {
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5); // 6 months total including current
      sixMonthsAgo.setDate(1);
      sixMonthsAgo.setHours(0, 0, 0, 0);
      invoiceDateFilter = { gte: sixMonthsAgo };
    }

    const invoices = await prisma.invoice.findMany({
      where: {
        patient: { clinicId, branchId },
        status: { notIn: ["draft", "cancelled"] },
        ...(Object.keys(invoiceDateFilter).length > 0 && { invoiceDate: invoiceDateFilter })
      },
      select: {
         amountPaid: true,
         invoiceDate: true
      }
    });

    // Determine the date bounds for the dynamic chart aggregation
    let aggStart;
    let aggEnd;

    if (startDate) {
      aggStart = new Date(startDate);
    } else {
      aggStart = new Date();
      aggStart.setMonth(aggStart.getMonth() - 5);
      aggStart.setDate(1);
      aggStart.setHours(0, 0, 0, 0);
    }

    if (endDate) {
      aggEnd = new Date(endDate);
    } else {
      aggEnd = new Date();
    }

    // Ensure aggStart is before aggEnd
    if (aggStart > aggEnd) {
      const temp = aggStart;
      aggStart = aggEnd;
      aggEnd = temp;
    }

    // Generate monthly keys between aggStart and aggEnd (limit to max 36 months)
    const months = [];
    let current = new Date(aggStart);
    current.setDate(1); // Avoid month overflow issues (e.g. Feb 31st logic)
    const limit = new Date(aggEnd);
    
    let iterations = 0;
    while (current <= limit && iterations < 36) {
      const monthLabel = current.toLocaleString('default', { month: 'short', year: '2-digit' });
      months.push(monthLabel);
      current.setMonth(current.getMonth() + 1);
      iterations++;
    }

    // Aggregate monthly revenue manually using dynamic month-year keys
    const revenueByMonthMap = {};
    invoices.forEach(inv => {
      const monthLabel = inv.invoiceDate.toLocaleString('default', { month: 'short', year: '2-digit' });
      revenueByMonthMap[monthLabel] = (revenueByMonthMap[monthLabel] || 0) + inv.amountPaid;
    });

    const revenueByMonth = months.map(m => ({
        month: m,
        revenue: revenueByMonthMap[m] || 0
    }));

    // 4. Clinical Insights
    const records = await prisma.record.findMany({
      where: {
        patient: { clinicId, branchId },
        isDeleted: false,
        ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter })
      },
      select: {
        diagnosis: true,
        presentingComplaint: true,
        patient: {
          select: { ageNumber: true }
        }
      }
    });

    const diagnosisMap = {};
    const complaintMap = {};
    const ageComplaintMap = { "0-18": {}, "19-35": {}, "36-50": {}, "51+": {} };

    const extractItems = (text) => {
      if (!text) return [];
      return text
        .split(/[\n\r,;]+/)
        .map(item => item.trim().toLowerCase())
        .map(item => item.replace(/^(c\/o\s*|complains of\s*|complaint of\s*|dx:\s*|diagnosis:\s*|\-\s*|\*\s*|\d+\.\s*)/i, '').trim())
        .map(item => item.replace(/\.$/, '').trim())
        .filter(item => item.length > 2);
    };

    records.forEach(r => {
      const diags = extractItems(r.diagnosis);
      const comps = extractItems(r.presentingComplaint);
      const age = r.patient?.ageNumber || 0;

      let ageGroup = "51+";
      if (age <= 18) ageGroup = "0-18";
      else if (age <= 35) ageGroup = "19-35";
      else if (age <= 50) ageGroup = "36-50";

      diags.forEach(diag => {
        diagnosisMap[diag] = (diagnosisMap[diag] || 0) + 1;
      });

      comps.forEach(comp => {
        complaintMap[comp] = (complaintMap[comp] || 0) + 1;
        ageComplaintMap[ageGroup][comp] = (ageComplaintMap[ageGroup][comp] || 0) + 1;
      });
    });

    const topDiagnoses = Object.entries(diagnosisMap).sort((a,b) => b[1] - a[1]).slice(0, 5).map(x => ({ name: x[0], count: x[1] }));
    const topComplaints = Object.entries(complaintMap).sort((a,b) => b[1] - a[1]).slice(0, 5).map(x => ({ name: x[0], count: x[1] }));
    
    const complaintsByAge = Object.keys(ageComplaintMap).map(group => {
       const topComp = Object.entries(ageComplaintMap[group]).sort((a,b) => b[1] - a[1])[0];
       return {
         ageGroup: group,
         topComplaint: topComp ? topComp[0] : "None",
         count: topComp ? topComp[1] : 0
       };
    });

    // 5. Enterprise Cross-Branch Insights
    let enterpriseData = null;
    if (req.user.role === "admin" && req.user.clinic?.plan === "ENTERPRISE") {
      const branches = await prisma.branch.findMany({ where: { clinicId }, select: { id: true, name: true } });
      const branchMap = branches.reduce((acc, b) => ({ ...acc, [b.id]: b.name }), {});

      const crossInvoices = await prisma.invoice.findMany({
        where: {
          patient: { clinicId },
          status: { notIn: ["draft", "cancelled"] },
          ...(Object.keys(invoiceDateFilter).length > 0 && { invoiceDate: invoiceDateFilter })
        },
        select: { branchId: true, amountPaid: true }
      });

      const branchRevenue = {};
      crossInvoices.forEach(inv => {
        const bId = inv.branchId;
        if (bId) {
           branchRevenue[bId] = (branchRevenue[bId] || 0) + inv.amountPaid;
        }
      });

      const crossAppointments = await prisma.appointment.groupBy({
        by: ['branchId'],
        where: {
          patient: { clinicId },
          ...(Object.keys(dateFilter).length > 0 && { appointmentDate: dateFilter })
        },
        _count: { id: true }
      });

      enterpriseData = {
        revenueByBranch: Object.entries(branchRevenue).map(([bId, total]) => ({ branchName: branchMap[bId] || 'Unknown', total })).sort((a,b) => b.total - a.total),
        appointmentsByBranch: crossAppointments.filter(a => a.branchId).map(a => ({ branchName: branchMap[a.branchId] || 'Unknown', count: a._count.id })).sort((a,b) => b.count - a.count)
      };
    }

    res.json({
      appointments: appointmentStatusCounts.map(a => ({ status: a.status, count: a._count.id })),
      demographics: genderDemographics.map(g => ({ gender: g.gender, count: g._count.id })),
      revenueByMonth,
      clinicalInsights: {
        topDiagnoses,
        totalDiagnoses: Object.keys(diagnosisMap).length,
        topComplaints,
        totalComplaints: Object.keys(complaintMap).length,
        complaintsByAge
      },
      enterprise: enterpriseData
    });

  } catch (error) {
    console.error("Analytics Error:", error);
    res.status(500).json({ message: "Failed to generate analytics report." });
  }
});

export default router;
