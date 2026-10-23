import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { withAuditedTransaction } from "../services/auditLog.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const getLocalMidnight = (dateValue, timeZone) => {
  const [year, month, day] = dateValue.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let guess = target;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(guess))
        .filter((part) => part.type !== "literal")
        .map(({ type, value }) => [type, Number(value)]),
    );
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const adjustment = target - represented;
    if (adjustment === 0) break;
    guess += adjustment;
  }

  return new Date(guess);
};

const getBusinessDayRange = (businessDate, timeZone) => {
  if (!datePattern.test(businessDate)) {
    throw new Error("Business date must use YYYY-MM-DD format.");
  }
  const parsedDate = new Date(`${businessDate}T00:00:00.000Z`);
  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== businessDate
  ) {
    throw new Error("Business date is invalid.");
  }

  const nextDate = new Date(parsedDate);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const start = getLocalMidnight(businessDate, timeZone);
  const end = getLocalMidnight(nextDate.toISOString().slice(0, 10), timeZone);
  return { start, end };
};

const roundCurrency = (amount) =>
  Math.round((Number(amount) + Number.EPSILON) * 100) / 100;

const closingInclude = {
  branch: { select: { id: true, name: true, city: true } },
  submittedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
  respondedBy: { select: { id: true, name: true } },
  resolvedBy: { select: { id: true, name: true } },
};

export const getCashReconciliations = async (req, res) => {
  try {
    const status = String(req.query.status || "pending");
    const fromDate = String(req.query.fromDate || "");
    const toDate = String(req.query.toDate || "");
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(25, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 25));
    const statusFilter = new Map([
      ["pending", { status: "pending" }],
      ["flagged", { status: "flagged" }],
      ["history", { status: { in: ["approved", "resolved"] } }],
    ]).get(status);
    if (!statusFilter) {
      return res.status(400).json({ message: "Select pending, flagged, or history." });
    }
    if (
      (fromDate && !datePattern.test(fromDate)) ||
      (toDate && !datePattern.test(toDate)) ||
      (fromDate && toDate && fromDate > toDate)
    ) {
      return res.status(400).json({ message: "Select a valid cash close date range." });
    }
    const where = {
      clinicId: req.user.clinicId,
      branchId: req.user.branchId,
      ...statusFilter,
      ...(fromDate || toDate
        ? {
            businessDate: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    };
    const [closings, total] = await Promise.all([
      prisma.cashReconciliation.findMany({
        where,
        include: closingInclude,
        orderBy: [{ businessDate: "desc" }, { submittedAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.cashReconciliation.count({ where }),
    ]);
    res.json({
      data: closings,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error("Fetch cash reconciliations error:", error);
    res.status(500).json({ message: "Failed to load cash reconciliations." });
  }
};

export const getPendingCashReconciliationCount = async (req, res) => {
  try {
    const count = await prisma.cashReconciliation.count({
      where: {
        clinicId: req.user.clinicId,
        branchId: req.user.branchId,
        status: "pending",
        OR: [
          { submittedById: null },
          { submittedById: { not: req.user.id } },
        ],
      },
    });
    res.json({ count });
  } catch (error) {
    console.error("Fetch pending cash reconciliation count error:", error);
    res.status(500).json({ message: "Failed to load pending cash close count." });
  }
};

export const submitCashReconciliation = async (req, res) => {
  try {
    const businessDate = String(req.body?.businessDate || "").trim();
    const timeZone = String(req.body?.timeZone || "").trim();
    const countedCash = Number(req.body?.countedCash);
    const notes = String(req.body?.notes || "").trim();

    if (!Number.isFinite(countedCash) || countedCash < 0) {
      return res.status(400).json({ message: "Enter a valid counted cash amount." });
    }
    if (!timeZone || timeZone.length > 100) {
      return res.status(400).json({ message: "A valid business time zone is required." });
    }
    if (notes.length > 500) {
      return res.status(400).json({ message: "Notes must be 500 characters or fewer." });
    }

    let range;
    try {
      range = getBusinessDayRange(businessDate, timeZone);
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
    const payments = await prisma.billingPayment.findMany({
      where: {
        branchId: req.user.branchId,
        paymentMethod: "cash",
        recordedAt: { gte: range.start, lt: range.end },
      },
      select: { amount: true, kind: true },
    });
    const expectedCash = roundCurrency(
      payments.reduce(
        (sum, payment) =>
          sum + (payment.kind === "reversal" ? -payment.amount : payment.amount),
        0,
      ),
    );
    const countedAmount = roundCurrency(countedCash);
    const variance = roundCurrency(countedAmount - expectedCash);

    const closing = await withAuditedTransaction(
      req,
      (created) => ({
        action: "cash_reconciliation.submit",
        resourceType: "cash_reconciliation",
        resourceId: created.id,
        branchId: created.branchId,
        metadata: {
          businessDate: created.businessDate,
          expectedCash: created.expectedCash,
          countedCash: created.countedCash,
          variance: created.variance,
        },
      }),
      (transaction) =>
        transaction.cashReconciliation.create({
          data: {
            clinicId: req.user.clinicId,
            branchId: req.user.branchId,
            businessDate,
            timezone: timeZone,
            expectedCash,
            countedCash: countedAmount,
            variance,
            notes,
            submittedById: req.user.id,
          },
          include: closingInclude,
        }),
    );
    res.status(201).json({ reconciliation: closing });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return res.status(409).json({
        message: "A cash close has already been submitted for this branch and date.",
      });
    }
    console.error("Submit cash reconciliation error:", error);
    res.status(500).json({ message: "Failed to submit cash close." });
  }
};

export const reviewCashReconciliation = async (req, res) => {
  try {
    const status = String(req.body?.status || "").trim();
    const reviewerNotes = String(req.body?.reviewerNotes || "").trim();
    if (!["approved", "flagged"].includes(status)) {
      return res.status(400).json({ message: "Select approved or flagged." });
    }
    if (reviewerNotes.length < 5 || reviewerNotes.length > 500) {
      return res.status(400).json({
        message: "Review notes must be between 5 and 500 characters.",
      });
    }

    const existing = await prisma.cashReconciliation.findFirst({
      where: {
        id: req.params.id,
        clinicId: req.user.clinicId,
        branchId: req.user.branchId,
      },
    });
    if (!existing) {
      return res.status(404).json({ message: "Cash close not found." });
    }
    if (existing.status !== "pending") {
      return res.status(409).json({ message: "This cash close has already been reviewed." });
    }
    if (existing.submittedById === req.user.id) {
      return res.status(403).json({
        message:
          "You cannot review your own cash close. Another admin or assigned branch manager must review it.",
      });
    }

    const closing = await withAuditedTransaction(
      req,
      (reviewed) => ({
        action: "cash_reconciliation.review",
        resourceType: "cash_reconciliation",
        resourceId: reviewed.id,
        branchId: reviewed.branchId,
        metadata: {
          status: reviewed.status,
          variance: reviewed.variance,
          reviewerNotes: reviewed.reviewerNotes,
        },
      }),
      async (transaction) => {
        const update = await transaction.cashReconciliation.updateMany({
          where: {
            id: existing.id,
            status: "pending",
            OR: [
              { submittedById: null },
              { submittedById: { not: req.user.id } },
            ],
          },
          data: {
            status,
            reviewerNotes,
            reviewedAt: new Date(),
            reviewedById: req.user.id,
          },
        });
        if (update.count !== 1) {
          const error = new Error("This cash close has already been reviewed.");
          error.statusCode = 409;
          throw error;
        }
        return transaction.cashReconciliation.findUnique({
          where: { id: existing.id },
          include: closingInclude,
        });
      },
    );
    res.json({ reconciliation: closing });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error("Review cash reconciliation error:", error);
    res.status(500).json({ message: "Failed to review cash close." });
  }
};

export const respondToFlaggedCashReconciliation = async (req, res) => {
  try {
    const followUpNotes = String(req.body?.followUpNotes || "").trim();
    if (followUpNotes.length < 5 || followUpNotes.length > 500) {
      return res.status(400).json({
        message: "Follow-up notes must be between 5 and 500 characters.",
      });
    }
    const existing = await prisma.cashReconciliation.findFirst({
      where: {
        id: req.params.id,
        clinicId: req.user.clinicId,
        branchId: req.user.branchId,
        status: "flagged",
      },
    });
    if (!existing) {
      return res.status(404).json({ message: "Flagged cash close not found." });
    }
    if (existing.submittedById !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({
        message: "Only the submitter or an admin can record the investigation response.",
      });
    }
    if (existing.followUpNotes) {
      return res.status(409).json({
        message: "An investigation response has already been recorded.",
      });
    }

    const closing = await withAuditedTransaction(
      req,
      (responded) => ({
        action: "cash_reconciliation.respond",
        resourceType: "cash_reconciliation",
        resourceId: responded.id,
        branchId: responded.branchId,
        metadata: { followUpNotes: responded.followUpNotes },
      }),
      async (transaction) => {
        const update = await transaction.cashReconciliation.updateMany({
          where: {
            id: existing.id,
            status: "flagged",
            followUpNotes: "",
          },
          data: {
            followUpNotes,
            respondedAt: new Date(),
            respondedById: req.user.id,
          },
        });
        if (update.count !== 1) {
          const error = new Error("An investigation response has already been recorded.");
          error.statusCode = 409;
          throw error;
        }
        return transaction.cashReconciliation.findUnique({
          where: { id: existing.id },
          include: closingInclude,
        });
      },
    );
    res.json({ reconciliation: closing });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error("Respond to flagged cash reconciliation error:", error);
    res.status(500).json({ message: "Failed to record investigation response." });
  }
};

export const resolveFlaggedCashReconciliation = async (req, res) => {
  try {
    const resolutionNotes = String(req.body?.resolutionNotes || "").trim();
    if (resolutionNotes.length < 5 || resolutionNotes.length > 500) {
      return res.status(400).json({
        message: "Resolution notes must be between 5 and 500 characters.",
      });
    }
    const existing = await prisma.cashReconciliation.findFirst({
      where: {
        id: req.params.id,
        clinicId: req.user.clinicId,
        branchId: req.user.branchId,
        status: "flagged",
      },
    });
    if (!existing) {
      return res.status(404).json({ message: "Flagged cash close not found." });
    }
    if (!existing.followUpNotes) {
      return res.status(409).json({
        message: "The submitter must record an investigation response before resolution.",
      });
    }
    if (existing.submittedById === req.user.id) {
      return res.status(403).json({
        message: "The submitter cannot resolve their own flagged cash close.",
      });
    }

    const closing = await withAuditedTransaction(
      req,
      (resolved) => ({
        action: "cash_reconciliation.resolve",
        resourceType: "cash_reconciliation",
        resourceId: resolved.id,
        branchId: resolved.branchId,
        metadata: { resolutionNotes: resolved.resolutionNotes },
      }),
      async (transaction) => {
        const update = await transaction.cashReconciliation.updateMany({
          where: {
            id: existing.id,
            status: "flagged",
            followUpNotes: { not: "" },
          },
          data: {
            status: "resolved",
            resolutionNotes,
            resolvedAt: new Date(),
            resolvedById: req.user.id,
          },
        });
        if (update.count !== 1) {
          const error = new Error("This flagged cash close has already been resolved.");
          error.statusCode = 409;
          throw error;
        }
        return transaction.cashReconciliation.findUnique({
          where: { id: existing.id },
          include: closingInclude,
        });
      },
    );
    res.json({ reconciliation: closing });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    console.error("Resolve flagged cash reconciliation error:", error);
    res.status(500).json({ message: "Failed to resolve flagged cash close." });
  }
};
