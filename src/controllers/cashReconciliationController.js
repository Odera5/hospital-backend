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
};

export const getCashReconciliations = async (req, res) => {
  try {
    const closings = await prisma.cashReconciliation.findMany({
      where: {
        clinicId: req.user.clinicId,
        branchId: req.user.branchId,
      },
      include: closingInclude,
      orderBy: { businessDate: "desc" },
      take: 90,
    });
    res.json({ data: closings });
  } catch (error) {
    console.error("Fetch cash reconciliations error:", error);
    res.status(500).json({ message: "Failed to load cash reconciliations." });
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
        message: "A cash close must be reviewed by a different staff member.",
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
