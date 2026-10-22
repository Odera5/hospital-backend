import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { withAuditedTransaction } from "../services/auditLog.js";
import { getAccessiblePatientBranchIds } from "../utils/branchAccess.js";
import { serializeInvoice } from "../utils/serializers.js";
import { toDecryptedPatient } from "../utils/patientCrypto.js";

const invoicePatientSelect = {
  id: true,
  clinicId: true,
  branchId: true,
  isDeleted: true,
  name: true,
  cardNumber: true,
  age: true,
  email: true,
  gender: true,
  phone: true,
  address: true,
};

const normalizeItems = (items) =>
  Array.isArray(items)
    ? items.map((item) => ({
        description: item.description,
        category: item.category || "service",
        quantity: Number(item.quantity) || 1,
        unitPrice: Number(item.unitPrice) || 0,
        totalPrice:
          Number(item.totalPrice) ||
          (Number(item.quantity) || 1) * (Number(item.unitPrice) || 0),
      }))
    : [];

const getInvoiceStatus = ({ status, total, amountPaid, dueDate }) => {
  if (status === "cancelled") return "cancelled";
  if (status === "draft") return "draft";
  if (amountPaid >= total && total > 0) return "paid";

  if (dueDate) {
    const due = new Date(dueDate);
    const now = new Date();
    if (due < now && amountPaid < total) {
      return "overdue";
    }
  }

  return "issued";
};

export const autoUpdateOverdueInvoices = async (req, res, next) => {
  try {
    await prisma.invoice.updateMany({
      where: {
        status: "issued",
        dueDate: {
          lt: new Date(),
        },
        balance: {
          gt: 0,
        },
      },
      data: {
        status: "overdue",
      },
    });
  } catch (error) {
    console.error("Auto update overdue invoices error:", error.message);
  }
  next();
};

const generateInvoiceNumber = async () => {
  const year = new Date().getFullYear();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `INV-${year}-${Date.now()}-${crypto
      .randomBytes(2)
      .toString("hex")
      .toUpperCase()}`;

    const existingInvoice = await prisma.invoice.findUnique({
      where: { invoiceNumber: candidate },
      select: { id: true },
    });

    if (!existingInvoice) {
      return candidate;
    }
  }

  throw new Error("Failed to generate a unique invoice number");
};

const invoiceInclude = {
  billingPayments: {
    include: {
      recordedBy: { select: { id: true, name: true } },
      reversedBy: { select: { id: true, name: true } },
    },
    orderBy: { recordedAt: "asc" },
  },
  patient: {
    select: invoicePatientSelect,
  },
};

const serializeInvoiceResult = (invoice) => {
  const { billingPayments = [], ...invoiceData } = invoice;
  return serializeInvoice({
    ...invoiceData,
    payments: billingPayments.map((payment) => ({
      id: payment.id,
      amount: payment.amount,
      paymentMethod: payment.paymentMethod,
      reference: payment.reference,
      notes: payment.notes,
      receiptNumber: payment.receiptNumber,
      kind: payment.kind,
      reversalOfId: payment.reversalOfId,
      reversalReason: payment.reversalReason,
      receivedAt: payment.recordedAt,
      recordedBy: payment.recordedBy,
      reversedBy: payment.reversedBy,
    })),
    patientId: toDecryptedPatient(invoice.patient),
  });
};

const isSerializableConflict = (error) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2034";

const createReceiptNumber = (prefix = "RCPT") =>
  `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

const roundCurrency = (amount) => Math.round((Number(amount) + Number.EPSILON) * 100) / 100;

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const getAllInvoices = async (req, res) => {
  try {
    const {
      patientId,
      status,
      startDate,
      endDate,
      page: pageParam,
      limit: limitParam,
    } = req.query;

    const where = {
      patient: {
        clinicId: req.user.clinicId,
      },
      OR: [
        { branchId: req.user.branchId },
        { branchId: null, patient: { branchId: req.user.branchId } }
      ],
      ...(patientId ? { patientId } : {}),
      ...(status === "unpaid"
        ? { status: { in: ["issued", "overdue"] }, amountPaid: 0 }
        : status === "incomplete"
        ? { status: { in: ["issued", "overdue"] }, amountPaid: { gt: 0 }, balance: { gt: 0 } }
        : status ? { status } : {}),
      ...((startDate || endDate)
        ? {
            invoiceDate: {
              ...(startDate ? { gte: new Date(startDate) } : {}),
              ...(endDate ? { lte: new Date(endDate) } : {}),
            },
          }
        : {}),
    };

    const shouldPaginate =
      pageParam !== undefined || limitParam !== undefined;

    if (!shouldPaginate) {
      const invoices = await prisma.invoice.findMany({
        where,
        include: invoiceInclude,
        orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
      });

      return res.json(invoices.map(serializeInvoiceResult));
    }

    const page = parsePositiveInteger(pageParam, 1);
    const limit = Math.min(parsePositiveInteger(limitParam, 20), 100);
    const skip = (page - 1) * limit;

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: invoiceInclude,
        orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }],
        skip,
        take: limit,
      }),
      prisma.invoice.count({ where }),
    ]);

    return res.json({
      data: invoices.map(serializeInvoiceResult),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("Get invoices error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const getInvoice = async (req, res) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: invoiceInclude,
    });

    if (!invoice || invoice.patient.clinicId !== req.user.clinicId || (invoice.branchId !== req.user.branchId && (invoice.branchId !== null || invoice.patient.branchId !== req.user.branchId))) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    res.json(serializeInvoiceResult(invoice));
  } catch (error) {
    console.error("Get invoice error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const createInvoice = async (req, res) => {
  try {
    const {
      patientId,
      treatmentPlanId,
      items,
      taxPercentage,
      discount,
      dueDate,
      notes,
    } = req.body;

    const normalizedItems = normalizeItems(items);

    if (!patientId || normalizedItems.length === 0) {
      return res
        .status(400)
        .json({ message: "Patient ID and items required" });
    }

    const patient = await prisma.patient.findFirst({
      where: {
        id: patientId,
        clinicId: req.user.clinicId,
        branchId: { in: getAccessiblePatientBranchIds(req.user) },
      },
    });
    if (!patient || patient.isDeleted) {
      return res.status(404).json({ message: "Patient not found" });
    }

    const subtotal = normalizedItems.reduce(
      (sum, item) => sum + (item.totalPrice || 0),
      0,
    );
    const tax = subtotal * ((Number(taxPercentage) || 0) / 100);
    const total = subtotal + tax - (Number(discount) || 0);

    if (req.user.role === "billing_staff" && Number(discount) > 0) {
      return res.status(403).json({
        message: "Discounts require a clinic admin to create or approve the invoice.",
      });
    }

    const invoiceNumber = await generateInvoiceNumber();
    const invoice = await withAuditedTransaction(
      req,
      (createdInvoice) => ({
        action: "invoice.create",
        resourceType: "invoice",
        resourceId: createdInvoice.id,
        patientId: patient.id,
        branchId: req.user.branchId,
        metadata: {
          total: createdInvoice.total,
          discount: createdInvoice.discount,
          itemCount: normalizedItems.length,
          status: createdInvoice.status,
        },
      }),
      (transaction) =>
        transaction.invoice.create({
          data: {
            invoiceNumber,
            patientId,
            branchId: req.user.branchId,
            treatmentPlanId: treatmentPlanId || null,
            items: normalizedItems,
            payments: [],
            subtotal,
            tax,
            taxPercentage: Number(taxPercentage) || 0,
            discount: Number(discount) || 0,
            total,
            balance: total,
            dueDate: dueDate ? new Date(dueDate) : null,
            notes: notes || "",
            status: "draft",
          },
          include: invoiceInclude,
        }),
    );

    res.status(201).json(serializeInvoiceResult(invoice));
  } catch (error) {
    console.error("Create invoice error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const updateInvoice = async (req, res) => {
  try {
    const { items, taxPercentage, discount, dueDate, notes } = req.body;

    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { patient: { select: { clinicId: true, branchId: true } } },
    });
    if (!invoice || invoice.patient.clinicId !== req.user.clinicId || (invoice.branchId !== req.user.branchId && (invoice.branchId !== null || invoice.patient.branchId !== req.user.branchId))) {
      return res.status(404).json({ message: "Invoice not found" });
    }
    if (invoice.status !== "draft" || Number(invoice.amountPaid) > 0) {
      return res.status(409).json({
        message: "Only unpaid draft invoices can be edited. Issued invoices are locked.",
      });
    }

    const normalizedItems =
      items !== undefined ? normalizeItems(items) : normalizeItems(invoice.items);
    const subtotal = normalizedItems.reduce(
      (sum, item) => sum + (item.totalPrice || 0),
      0,
    );
    const nextTaxPercentage =
      taxPercentage !== undefined ? Number(taxPercentage) : invoice.taxPercentage;
    const nextDiscount =
      discount !== undefined ? Number(discount) : invoice.discount;
    if (req.user.role === "billing_staff" && nextDiscount > 0) {
      return res.status(403).json({
        message: "Discounts require a clinic admin to create or approve the invoice.",
      });
    }
    const tax = subtotal * ((Number(nextTaxPercentage) || 0) / 100);
    const total = subtotal + tax - nextDiscount;
    if (total < 0) {
      return res.status(400).json({ message: "Invoice total cannot be negative" });
    }

    const updatedInvoice = await withAuditedTransaction(
      req,
      (updated) => ({
        action: "invoice.update",
        resourceType: "invoice",
        resourceId: updated.id,
        patientId: updated.patientId,
        branchId: req.user.branchId,
        metadata: {
          updatedFields: Object.keys(req.body),
          total: updated.total,
          discount: updated.discount,
          status: updated.status,
        },
      }),
      (transaction) =>
        transaction.invoice.update({
          where: { id: invoice.id },
          data: {
            ...(items !== undefined ? { items: normalizedItems } : {}),
            subtotal,
            tax,
            taxPercentage: nextTaxPercentage,
            discount: nextDiscount,
            total,
            balance: total,
            status: "draft",
            ...(dueDate !== undefined
              ? { dueDate: dueDate ? new Date(dueDate) : null }
              : {}),
            ...(notes !== undefined ? { notes } : {}),
          },
          include: invoiceInclude,
        }),
    );

    res.json(serializeInvoiceResult(updatedInvoice));
  } catch (error) {
    console.error("Update invoice error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const issueInvoice = async (req, res) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { patient: { select: { clinicId: true, branchId: true } } },
    });
    if (!invoice || invoice.patient.clinicId !== req.user.clinicId || (invoice.branchId !== req.user.branchId && (invoice.branchId !== null || invoice.patient.branchId !== req.user.branchId))) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    if (invoice.status !== "draft") {
      return res.status(409).json({ message: "Only draft invoices can be issued." });
    }

    const nextStatus = getInvoiceStatus({
      status: "issued",
      total: invoice.total,
      amountPaid: invoice.amountPaid,
      dueDate: invoice.dueDate,
    });

    const updatedInvoice = await withAuditedTransaction(
      req,
      (issuedInvoice) => ({
        action: "invoice.issue",
        resourceType: "invoice",
        resourceId: issuedInvoice.id,
        patientId: issuedInvoice.patientId,
        branchId: req.user.branchId,
        metadata: {
          status: issuedInvoice.status,
          total: issuedInvoice.total,
        },
      }),
      (transaction) =>
        transaction.invoice.update({
          where: { id: invoice.id },
          data: {
            status: nextStatus,
            invoiceDate: new Date(),
          },
          include: invoiceInclude,
        }),
    );

    res.json(serializeInvoiceResult(updatedInvoice));
  } catch (error) {
    console.error("Issue invoice error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const recordPayment = async (req, res) => {
  try {
    const { amount, paymentMethod, reference, notes } = req.body;
    const paymentAmount = roundCurrency(amount);
    const normalizedMethod = String(paymentMethod || "").trim();
    const normalizedReference = String(reference || "").trim();
    const normalizedNotes = String(notes || "").trim();
    const allowedMethods = ["cash", "card", "bank_transfer", "check"];

    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
      return res.status(400).json({ message: "Valid payment amount required" });
    }
    if (!allowedMethods.includes(normalizedMethod)) {
      return res.status(400).json({ message: "Select a valid payment method." });
    }
    if (normalizedMethod !== "cash" && !normalizedReference) {
      return res.status(400).json({
        message: "A transaction or receipt reference is required for non-cash payments.",
      });
    }
    if (normalizedReference.length > 120 || normalizedNotes.length > 500) {
      return res.status(400).json({ message: "Reference or notes are too long." });
    }

    let result;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        result = await withAuditedTransaction(
          req,
          ({ invoice: paidInvoice, payment }) => ({
            action: "invoice.payment.recorded",
            resourceType: "invoice",
            resourceId: paidInvoice.id,
            patientId: paidInvoice.patientId,
            branchId: payment.branchId,
            metadata: {
              paymentId: payment.id,
              receiptNumber: payment.receiptNumber,
              paymentAmount: payment.amount,
              amountPaidTotal: paidInvoice.amountPaid,
              balance: paidInvoice.balance,
              paymentMethod: payment.paymentMethod,
              status: paidInvoice.status,
            },
          }),
          async (transaction) => {
            const invoice = await transaction.invoice.findUnique({
              where: { id: req.params.id },
              include: { patient: { select: { clinicId: true, branchId: true } } },
            });
            if (
              !invoice ||
              invoice.patient.clinicId !== req.user.clinicId ||
              (invoice.branchId !== req.user.branchId &&
                (invoice.branchId !== null ||
                  invoice.patient.branchId !== req.user.branchId))
            ) {
              const error = new Error("Invoice not found");
              error.statusCode = 404;
              throw error;
            }
            if (!["issued", "overdue"].includes(invoice.status)) {
              const error = new Error("Payments can only be recorded against issued invoices.");
              error.statusCode = 409;
              throw error;
            }

            const nextAmountPaid = roundCurrency(
              Number(invoice.amountPaid || 0) + paymentAmount,
            );
            const balance = roundCurrency(Number(invoice.total) - nextAmountPaid);
            if (balance < 0) {
              const error = new Error(
                `Payment exceeds remaining balance of ${Math.max(0, Number(invoice.balance) || 0).toFixed(2)}`,
              );
              error.statusCode = 400;
              throw error;
            }

            const branchId = invoice.branchId || invoice.patient.branchId;
            const payment = await transaction.billingPayment.create({
              data: {
                invoiceId: invoice.id,
                branchId,
                amount: paymentAmount,
                paymentMethod: normalizedMethod,
                reference: normalizedReference,
                notes: normalizedNotes,
                receiptNumber: createReceiptNumber(),
                recordedById: req.user.id,
              },
            });
            const nextStatus = getInvoiceStatus({
              status: invoice.status,
              total: invoice.total,
              amountPaid: nextAmountPaid,
              dueDate: invoice.dueDate,
            });
            const updatedInvoice = await transaction.invoice.update({
              where: { id: invoice.id },
              data: {
                amountPaid: nextAmountPaid,
                balance,
                paymentMethod: normalizedMethod,
                status: nextStatus,
              },
              include: invoiceInclude,
            });
            return { invoice: updatedInvoice, payment };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error) {
        if (isSerializableConflict(error) && attempt < 2) continue;
        throw error;
      }
    }

    if (!result?.invoice) throw new Error("Payment could not be recorded.");
    res.json(serializeInvoiceResult(result.invoice));
  } catch (error) {
    console.error("Record payment error:", error.message);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    res.status(500).json({ message: "Server error" });
  }
};

export const reversePayment = async (req, res) => {
  try {
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 5 || reason.length > 500) {
      return res.status(400).json({
        message: "Provide a reversal reason between 5 and 500 characters.",
      });
    }

    let updatedInvoice;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        updatedInvoice = await withAuditedTransaction(
          req,
          ({ invoice, reversal }) => ({
            action: "invoice.payment.reversed",
            resourceType: "invoice",
            resourceId: invoice.id,
            patientId: invoice.patientId,
            branchId: reversal.branchId,
            metadata: {
              paymentId: reversal.reversalOfId,
              reversalId: reversal.id,
              receiptNumber: reversal.receiptNumber,
              amount: reversal.amount,
              reason: reversal.reversalReason,
            },
          }),
          async (transaction) => {
            const invoice = await transaction.invoice.findUnique({
              where: { id: req.params.id },
              include: { patient: { select: { clinicId: true, branchId: true } } },
            });
            if (
              !invoice ||
              invoice.patient.clinicId !== req.user.clinicId ||
              (invoice.branchId !== req.user.branchId &&
                (invoice.branchId !== null ||
                  invoice.patient.branchId !== req.user.branchId))
            ) {
              const error = new Error("Invoice not found");
              error.statusCode = 404;
              throw error;
            }

            const original = await transaction.billingPayment.findUnique({
              where: { id: req.params.paymentId },
              include: { reversal: true },
            });
            if (
              !original ||
              original.invoiceId !== invoice.id ||
              original.kind !== "recorded" ||
              original.reversal
            ) {
              const error = new Error("Payment not found or already reversed.");
              error.statusCode = 404;
              throw error;
            }
            if (Number(invoice.amountPaid) < Number(original.amount)) {
              const error = new Error("Invoice payment totals are inconsistent; contact support.");
              error.statusCode = 409;
              throw error;
            }

            const nextAmountPaid = roundCurrency(
              Number(invoice.amountPaid) - Number(original.amount),
            );
            const balance = roundCurrency(Number(invoice.total) - nextAmountPaid);
            const reversal = await transaction.billingPayment.create({
              data: {
                invoiceId: invoice.id,
                branchId: original.branchId,
                amount: original.amount,
                paymentMethod: original.paymentMethod,
                reference: original.reference,
                notes: `Reversal of ${original.receiptNumber}`,
                receiptNumber: createReceiptNumber("REV"),
                kind: "reversal",
                reversalOfId: original.id,
                reversalReason: reason,
                reversedById: req.user.id,
              },
            });
            const nextStatus = getInvoiceStatus({
              status: "issued",
              total: invoice.total,
              amountPaid: nextAmountPaid,
              dueDate: invoice.dueDate,
            });
            const result = await transaction.invoice.update({
              where: { id: invoice.id },
              data: {
                amountPaid: nextAmountPaid,
                balance,
                status: nextStatus,
              },
              include: invoiceInclude,
            });
            return { invoice: result, reversal };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error) {
        if (isSerializableConflict(error) && attempt < 2) continue;
        throw error;
      }
    }

    if (!updatedInvoice?.invoice) throw new Error("Payment reversal could not be recorded.");
    res.json(serializeInvoiceResult(updatedInvoice.invoice));
  } catch (error) {
    console.error("Reverse payment error:", error.message);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    res.status(500).json({ message: "Server error" });
  }
};

export const cancelInvoice = async (req, res) => {
  try {
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 5 || reason.length > 500) {
      return res.status(400).json({
        message: "Provide a cancellation reason between 5 and 500 characters.",
      });
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        patient: { select: { clinicId: true, branchId: true } },
        billingPayments: { select: { id: true } },
      },
    });
    if (
      !invoice ||
      invoice.patient.clinicId !== req.user.clinicId ||
      (invoice.branchId !== req.user.branchId &&
        (invoice.branchId !== null ||
          invoice.patient.branchId !== req.user.branchId))
    ) {
      return res.status(404).json({ message: "Invoice not found" });
    }
    if (invoice.status === "cancelled") {
      return res.status(409).json({ message: "Invoice is already cancelled." });
    }
    if (Number(invoice.amountPaid) > 0 || invoice.billingPayments.length > 0) {
      return res.status(409).json({
        message: "Reverse recorded payments before cancelling this invoice.",
      });
    }

    const cancelled = await withAuditedTransaction(
      req,
      (updatedInvoice) => ({
        action: "invoice.cancel",
        resourceType: "invoice",
        resourceId: updatedInvoice.id,
        patientId: updatedInvoice.patientId,
        branchId: req.user.branchId,
        metadata: { reason },
      }),
      (transaction) =>
        transaction.invoice.update({
          where: { id: invoice.id },
          data: { status: "cancelled" },
          include: invoiceInclude,
        }),
    );
    res.json({
      message: "Invoice cancelled",
      invoice: serializeInvoiceResult(cancelled),
    });
  } catch (error) {
    console.error("Cancel invoice error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const getInvoiceReport = async (req, res) => {
  try {
    const { startDate, endDate, patientId } = req.query;
    const invoiceWhere = {
      patient: {
        clinicId: req.user.clinicId,
      },
      OR: [
        { branchId: req.user.branchId },
        { branchId: null, patient: { branchId: req.user.branchId } }
      ],
      ...(patientId ? { patientId } : {}),
      status: { not: "draft" },
      ...((startDate || endDate)
        ? {
            invoiceDate: {
              ...(startDate ? { gte: new Date(startDate) } : {}),
              ...(endDate ? { lte: new Date(endDate) } : {}),
            },
          }
        : {}),
    };

    const dueTodayStart = new Date();
    dueTodayStart.setHours(0, 0, 0, 0);
    const dueTodayEnd = new Date();
    dueTodayEnd.setHours(23, 59, 59, 999);

    const [invoiceAggregate, statusGroups, draftCount, dueTodayCount, unpaidPatients, incompletePatients] = await Promise.all([
      prisma.invoice.aggregate({
        where: invoiceWhere,
        _count: { _all: true },
        _sum: {
          total: true,
          amountPaid: true,
          balance: true,
        },
      }),
      prisma.invoice.groupBy({
        by: ["status"],
        where: invoiceWhere,
        _count: { _all: true },
      }),
      prisma.invoice.count({
        where: {
          patient: { clinicId: req.user.clinicId },
          OR: [
            { branchId: req.user.branchId },
            { branchId: null, patient: { branchId: req.user.branchId } }
          ],
          ...(patientId ? { patientId } : {}),
          status: "draft",
        },
      }),
      prisma.invoice.count({
        where: {
          patient: { clinicId: req.user.clinicId },
          OR: [
            { branchId: req.user.branchId },
            { branchId: null, patient: { branchId: req.user.branchId } }
          ],
          ...(patientId ? { patientId } : {}),
          status: { in: ["issued", "overdue"] },
          balance: { gt: 0 },
          dueDate: {
            gte: dueTodayStart,
            lte: dueTodayEnd,
          },
        },
      }),
      prisma.invoice.groupBy({
        by: ["patientId"],
        where: {
          patient: { clinicId: req.user.clinicId },
          OR: [
            { branchId: req.user.branchId },
            { branchId: null, patient: { branchId: req.user.branchId } }
          ],
          ...(patientId ? { patientId } : {}),
          status: { notIn: ["draft", "cancelled"] },
          amountPaid: 0,
          balance: { gt: 0 },
        },
      }),
      prisma.invoice.groupBy({
        by: ["patientId"],
        where: {
          patient: { clinicId: req.user.clinicId },
          OR: [
            { branchId: req.user.branchId },
            { branchId: null, patient: { branchId: req.user.branchId } }
          ],
          ...(patientId ? { patientId } : {}),
          status: { notIn: ["draft", "cancelled"] },
          amountPaid: { gt: 0 },
          balance: { gt: 0 },
        },
      }),
    ]);

    const getStatusCount = (targetStatus) =>
      statusGroups.find((group) => group.status === targetStatus)?._count._all || 0;

    const report = {
      totalInvoices: invoiceAggregate._count._all || 0,
      totalRevenue: invoiceAggregate._sum.total || 0,
      totalPaid: invoiceAggregate._sum.amountPaid || 0,
      totalOutstanding: invoiceAggregate._sum.balance || 0,
      paidInvoices: getStatusCount("paid"),
      overdueInvoices: getStatusCount("overdue"),
      unpaidPatients: unpaidPatients.length,
      incompletePatients: incompletePatients.length,
      dueToday: dueTodayCount,
      drafts: draftCount,
    };

    res.json(report);
  } catch (error) {
    console.error("Get invoice report error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const getInvoicePatients = async (req, res) => {
  try {
    const patients = await prisma.patient.findMany({
      where: {
        clinicId: req.user.clinicId,
        branchId: req.user.branchId,
        isDeleted: false,
        invoices: {
          some: {},
        },
      },
      select: invoicePatientSelect,
      orderBy: { createdAt: "desc" },
    });

    res.json(
      patients.map((patient) => {
        const decrypted = toDecryptedPatient(patient);
        return {
          id: decrypted.id,
          name: decrypted.name,
          phone: decrypted.phone,
          email: decrypted.email,
        };
      }),
    );
  } catch (error) {
    console.error("Get invoice patients error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};
