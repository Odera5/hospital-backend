import express from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import { requireProOrEnterprise } from "../middleware/subscriptionGuard.js";
import { enforceSubscriptionState } from "../middleware/subscriptionStateGuard.js";
import { autoUpdateOverdueInvoices } from "../controllers/invoiceController.js";

const router = express.Router();
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
router.use(protect);
router.use(enforceSubscriptionState({ allowAdminReadOnly: true }));
router.use(autoUpdateOverdueInvoices);

const parseDate = (value, fieldName) => {
  if (!value) return null;
  if (!datePattern.test(value)) {
    throw new Error(`${fieldName} must use YYYY-MM-DD format.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${fieldName} is invalid.`);
  }
  return date;
};

const endOfDay = (date) => {
  const inclusiveEnd = new Date(date);
  inclusiveEnd.setUTCHours(23, 59, 59, 999);
  return inclusiveEnd;
};

const getDefaultRevenueStart = () => {
  const start = new Date();
  start.setMonth(start.getMonth() - 5);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start;
};

const buildDateSql = (column, startDate, endDate) => {
  const clauses = [];
  if (startDate) clauses.push(Prisma.sql`${column} >= ${startDate}`);
  if (endDate) clauses.push(Prisma.sql`${column} <= ${endOfDay(endDate)}`);
  return clauses.length ? Prisma.sql`AND ${Prisma.join(clauses, " AND ")}` : Prisma.empty;
};

const getClinicalInsightQueries = async ({ clinicId, branchId, startDate, endDate }) => {
  const recordDateFilter = buildDateSql(
    Prisma.raw('r."createdAt"'),
    startDate,
    endDate,
  );
  const diagnosisRows = await prisma.$queryRaw`
    WITH scoped_records AS (
      SELECT r.diagnosis
      FROM "Record" r
      INNER JOIN "Patient" p ON p.id = r."patientId"
      WHERE p."clinicId" = ${clinicId}
        AND p."branchId" = ${branchId}
        AND p."isDeleted" = false
        AND r."isDeleted" = false
        ${recordDateFilter}
    ),
    diagnosis_items AS (
      SELECT regexp_replace(
        regexp_replace(
          lower(trim(item)),
          '^(c/o[[:space:]]*|complains of[[:space:]]*|complaint of[[:space:]]*|dx:[[:space:]]*|diagnosis:[[:space:]]*|[-*][[:space:]]*|[0-9]+\\.[[:space:]]*)',
          ''
        ),
        '[.]$',
        ''
      ) AS name
      FROM scoped_records r
      CROSS JOIN LATERAL regexp_split_to_table(
        coalesce(r.diagnosis, ''),
        '[,;]|' || chr(10) || '|' || chr(13)
      ) AS split(item)
    ),
    diagnosis_counts AS (
      SELECT name, count(*)::int AS count
      FROM diagnosis_items
      WHERE length(name) > 2
      GROUP BY name
    )
    SELECT name, count, count(*) OVER()::int AS "totalDiagnoses"
    FROM diagnosis_counts
    ORDER BY count DESC, name ASC
    LIMIT 5
  `;

  const complaintRows = await prisma.$queryRaw`
    WITH scoped_records AS (
      SELECT r."presentingComplaint", p."ageNumber"
      FROM "Record" r
      INNER JOIN "Patient" p ON p.id = r."patientId"
      WHERE p."clinicId" = ${clinicId}
        AND p."branchId" = ${branchId}
        AND p."isDeleted" = false
        AND r."isDeleted" = false
        ${recordDateFilter}
    ),
    complaint_items AS (
      SELECT
        CASE
          WHEN coalesce("ageNumber", 0) <= 18 THEN '0-18'
          WHEN "ageNumber" <= 35 THEN '19-35'
          WHEN "ageNumber" <= 50 THEN '36-50'
          ELSE '51+'
        END AS "ageGroup",
        regexp_replace(
          regexp_replace(
            lower(trim(item)),
            '^(c/o[[:space:]]*|complains of[[:space:]]*|complaint of[[:space:]]*|dx:[[:space:]]*|diagnosis:[[:space:]]*|[-*][[:space:]]*|[0-9]+\\.[[:space:]]*)',
            ''
          ),
          '[.]$',
          ''
        ) AS name
      FROM scoped_records r
      CROSS JOIN LATERAL regexp_split_to_table(
        coalesce(r."presentingComplaint", ''),
        '[,;]|' || chr(10) || '|' || chr(13)
      ) AS split(item)
    ),
    complaint_counts AS (
      SELECT "ageGroup", name, count(*)::int AS count
      FROM complaint_items
      WHERE length(name) > 2
      GROUP BY "ageGroup", name
    ),
    ranked_complaints AS (
      SELECT
        "ageGroup",
        name,
        count,
        row_number() OVER (ORDER BY count DESC, name ASC) AS overall_rank,
        row_number() OVER (PARTITION BY "ageGroup" ORDER BY count DESC, name ASC) AS age_rank
      FROM complaint_counts
    ),
    complaint_total AS (
      SELECT count(DISTINCT name)::int AS "totalComplaints"
      FROM complaint_counts
    )
    SELECT
      ranked_complaints."ageGroup",
      ranked_complaints.name,
      ranked_complaints.count,
      ranked_complaints.overall_rank,
      ranked_complaints.age_rank,
      complaint_total."totalComplaints"
    FROM ranked_complaints
    CROSS JOIN complaint_total
    WHERE ranked_complaints.overall_rank <= 5
       OR ranked_complaints.age_rank = 1
    ORDER BY ranked_complaints.overall_rank
  `;

  const topDiagnoses = diagnosisRows.map(({ name, count }) => ({
    name,
    count: Number(count),
  }));
  const topComplaints = complaintRows
    .filter((row) => Number(row.overall_rank) <= 5)
    .map(({ name, count }) => ({ name, count: Number(count) }));
  const ageGroups = ["0-18", "19-35", "36-50", "51+"];
  const complaintsByAge = ageGroups.map((ageGroup) => {
    const top = complaintRows.find(
      (row) => row.ageGroup === ageGroup && Number(row.age_rank) === 1,
    );
    return {
      ageGroup,
      topComplaint: top?.name || "None",
      count: Number(top?.count || 0),
    };
  });

  return {
    topDiagnoses,
    totalDiagnoses: Number(diagnosisRows[0]?.totalDiagnoses || 0),
    topComplaints,
    totalComplaints: Number(complaintRows[0]?.totalComplaints || 0),
    complaintsByAge,
  };
};

router.get(
  "/dashboard",
  protect,
  authorizeRoles("admin", "branch_manager", "doctor"),
  requireProOrEnterprise,
  async (req, res) => {
    try {
      const clinicId = req.user.clinicId;
      const branchId = req.user.branchId;
      let startDate;
      let endDate;
      try {
        startDate = parseDate(String(req.query.startDate || ""), "Start date");
        endDate = parseDate(String(req.query.endDate || ""), "End date");
      } catch (error) {
        return res.status(400).json({ message: error.message });
      }
      if (startDate && endDate && startDate > endDate) {
        return res.status(400).json({ message: "Start date must be before end date." });
      }
      const reportStart = startDate || getDefaultRevenueStart();
      const reportEnd = endDate || new Date();
      const maximumReportEnd = new Date(reportStart);
      maximumReportEnd.setUTCMonth(maximumReportEnd.getUTCMonth() + 36);
      if (reportEnd > maximumReportEnd) {
        return res.status(400).json({
          message: "Reports can cover up to 36 months at a time.",
        });
      }
      const dateFilter = {};
      if (startDate) dateFilter.gte = startDate;
      if (endDate) dateFilter.lte = endOfDay(endDate);

      const appointmentStatusCounts = await prisma.appointment.groupBy({
        by: ["status"],
        where: {
          patient: { clinicId, branchId },
          ...(Object.keys(dateFilter).length > 0
            ? { appointmentDate: dateFilter }
            : {}),
        },
        _count: { id: true },
      });
      const genderDemographics = await prisma.patient.groupBy({
        by: ["gender"],
        where: {
          clinicId,
          branchId,
          isDeleted: false,
          ...(Object.keys(dateFilter).length > 0
            ? { createdAt: dateFilter }
            : {}),
        },
        _count: { id: true },
      });

      const revenueStart = reportStart;
      const revenueEnd = endDate ? endOfDay(endDate) : new Date();
      const monthlyInvoices = await prisma.$queryRaw`
        SELECT date_trunc('month', i."invoiceDate") AS month,
               coalesce(sum(i."amountPaid"), 0)::double precision AS revenue
        FROM "Invoice" i
        INNER JOIN "Patient" p ON p.id = i."patientId"
        WHERE p."clinicId" = ${clinicId}
          AND p."branchId" = ${branchId}
          AND i.status NOT IN ('draft', 'cancelled')
          AND i."invoiceDate" >= ${revenueStart}
          AND i."invoiceDate" <= ${revenueEnd}
        GROUP BY date_trunc('month', i."invoiceDate")
        ORDER BY month ASC
      `;
      const months = [];
      const monthCursor = new Date(revenueStart);
      monthCursor.setDate(1);
      monthCursor.setHours(0, 0, 0, 0);
      const lastMonth = new Date(revenueEnd);
      lastMonth.setDate(1);
      lastMonth.setHours(0, 0, 0, 0);
      while (monthCursor <= lastMonth && months.length < 36) {
        months.push(new Date(monthCursor));
        monthCursor.setMonth(monthCursor.getMonth() + 1);
      }
      const revenueByMonthMap = new Map(
        monthlyInvoices.map((row) => [
          `${row.month.getFullYear()}-${row.month.getMonth()}`,
          Number(row.revenue),
        ]),
      );
      const revenueByMonth = months.map((month) => ({
        month: month.toLocaleString("default", { month: "short", year: "2-digit" }),
        revenue: revenueByMonthMap.get(
          `${month.getFullYear()}-${month.getMonth()}`,
        ) || 0,
      }));

      const clinicalInsights = await getClinicalInsightQueries({
        clinicId,
        branchId,
        startDate: reportStart,
        endDate: reportEnd,
      });

      let enterpriseData = null;
      if (req.user.role === "admin" && req.user.clinic?.plan === "ENTERPRISE") {
        const [branches, branchRevenue, crossAppointments] = await Promise.all([
          prisma.branch.findMany({
            where: { clinicId },
            select: { id: true, name: true },
          }),
          prisma.invoice.groupBy({
            by: ["branchId"],
            where: {
              patient: { clinicId },
              status: { notIn: ["draft", "cancelled"] },
              invoiceDate: { gte: revenueStart, lte: revenueEnd },
            },
            _sum: { amountPaid: true },
          }),
          prisma.appointment.groupBy({
            by: ["branchId"],
            where: {
              patient: { clinicId },
              ...(Object.keys(dateFilter).length > 0
                ? { appointmentDate: dateFilter }
                : {}),
            },
            _count: { id: true },
          }),
        ]);
        const branchNames = new Map(branches.map((branch) => [branch.id, branch.name]));
        enterpriseData = {
          revenueByBranch: branchRevenue
            .filter((item) => item.branchId)
            .map((item) => ({
              branchName: branchNames.get(item.branchId) || "Unknown",
              total: Number(item._sum.amountPaid || 0),
            }))
            .sort((left, right) => right.total - left.total),
          appointmentsByBranch: crossAppointments
            .filter((item) => item.branchId)
            .map((item) => ({
              branchName: branchNames.get(item.branchId) || "Unknown",
              count: item._count.id,
            }))
            .sort((left, right) => right.count - left.count),
        };
      }

      return res.json({
        appointments: appointmentStatusCounts.map((item) => ({
          status: item.status,
          count: item._count.id,
        })),
        demographics: genderDemographics.map((item) => ({
          gender: item.gender,
          count: item._count.id,
        })),
        revenueByMonth,
        clinicalInsights,
        enterprise: enterpriseData,
      });
    } catch (error) {
      console.error("Analytics Error:", error);
      return res.status(500).json({ message: "Failed to generate analytics report." });
    }
  },
);

export default router;
