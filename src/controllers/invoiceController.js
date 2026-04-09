import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { logAuditEvent } from "../services/auditLog.js";
import { serializeInvoice } from "../utils/serializers.js";
import { toDecryptedPatient } from "../utils/patientCrypto.js";

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

const normalizePayments = (payments) =>
  Array.isArray(payments)
    ? payments
        .map((payment) => ({
          id: payment.id || crypto.randomUUID(),
          amount: Number(payment.amount) || 0,
          paymentMethod: payment.paymentMethod || "cash",
          notes: payment.notes || "",
          receivedAt: payment.receivedAt || new Date().toISOString(),
        }))
        .filter((payment) => payment.amount > 0)
    : [];

const sumPayments = (payments) =>
  normalizePayments(payments).reduce((sum, payment) => sum + payment.amount, 0);

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
  patient: true,
};

const serializeInvoiceResult = (invoice) =>
  serializeInvoice({
    ...invoice,
    patientId: toDecryptedPatient(invoice.patient),
  });

export const getAllInvoices = async (req, res) => {
  try {
    const { patientId, status, startDate, endDate } = req.query;

    const invoices = await prisma.invoice.findMany({
      where: {
        patient: {
          clinicId: req.user.clinicId,
        },
        ...(patientId ? { patientId } : {}),
        ...(status ? { status } : {}),
        ...((startDate || endDate)
          ? {
              invoiceDate: {
                ...(startDate ? { gte: new Date(startDate) } : {}),
                ...(endDate ? { lte: new Date(endDate) } : {}),
              },
            }
          : {}),
      },
      include: invoiceInclude,
      orderBy: { invoiceDate: "desc" },
    });

    res.json(invoices.map(serializeInvoiceResult));
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

    if (!invoice || invoice.patient.clinicId !== req.user.clinicId) {
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
      where: { id: patientId, clinicId: req.user.clinicId },
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

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: await generateInvoiceNumber(),
        patientId,
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
    });

    await logAuditEvent(req, {
      action: "invoice.create",
      resourceType: "invoice",
      resourceId: invoice.id,
      patientId: patient.id,
      metadata: {
        total: invoice.total,
        itemCount: normalizedItems.length,
        status: invoice.status,
      },
    });

    res.status(201).json(serializeInvoiceResult(invoice));
  } catch (error) {
    console.error("Create invoice error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const updateInvoice = async (req, res) => {
  try {
    const {
      items,
      taxPercentage,
      discount,
      status,
      amountPaid,
      paymentMethod,
      dueDate,
      notes,
    } = req.body;

    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { patient: { select: { clinicId: true } } },
    });
    if (!invoice || invoice.patient.clinicId !== req.user.clinicId) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const normalizedItems =
      items !== undefined ? normalizeItems(items) : normalizeItems(invoice.items);
    const normalizedPayments = normalizePayments(invoice.payments);
    const subtotal = normalizedItems.reduce(
      (sum, item) => sum + (item.totalPrice || 0),
      0,
    );
    const nextTaxPercentage =
      taxPercentage !== undefined ? Number(taxPercentage) : invoice.taxPercentage;
    const nextDiscount =
      discount !== undefined ? Number(discount) : invoice.discount;
    const tax = subtotal * ((Number(nextTaxPercentage) || 0) / 100);
    const total = subtotal + tax - nextDiscount;
    const nextAmountPaid =
      amountPaid !== undefined ? Number(amountPaid) : sumPayments(normalizedPayments);
    const balance = total - nextAmountPaid;

    if (nextAmountPaid < 0) {
      return res.status(400).json({ message: "Amount paid cannot be negative" });
    }

    if (nextAmountPaid > total) {
      return res.status(400).json({
        message: "Amount paid cannot be greater than the invoice total",
      });
    }

    const nextStatus = status
      ? status
      : getInvoiceStatus({
          status: invoice.status,
          total,
          amountPaid: nextAmountPaid,
          dueDate: dueDate !== undefined ? dueDate : invoice.dueDate,
        });

    const updatedInvoice = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        ...(items !== undefined ? { items: normalizedItems } : {}),
        payments: normalizedPayments,
        subtotal,
        tax,
        taxPercentage: nextTaxPercentage,
        discount: nextDiscount,
        total,
        amountPaid: nextAmountPaid,
        balance,
        status: nextStatus,
        ...(paymentMethod ? { paymentMethod } : {}),
        ...(dueDate !== undefined
          ? { dueDate: dueDate ? new Date(dueDate) : null }
          : {}),
        ...(notes !== undefined ? { notes } : {}),
      },
      include: invoiceInclude,
    });

    await logAuditEvent(req, {
      action: "invoice.update",
      resourceType: "invoice",
      resourceId: updatedInvoice.id,
      patientId: updatedInvoice.patientId,
      metadata: {
        total: updatedInvoice.total,
        amountPaid: updatedInvoice.amountPaid,
        status: updatedInvoice.status,
      },
    });

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
      include: { patient: { select: { clinicId: true } } },
    });
    if (!invoice || invoice.patient.clinicId !== req.user.clinicId) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const updatedInvoice = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: "issued",
        invoiceDate: new Date(),
      },
      include: invoiceInclude,
    });

    await logAuditEvent(req, {
      action: "invoice.issue",
      resourceType: "invoice",
      resourceId: updatedInvoice.id,
      patientId: updatedInvoice.patientId,
      metadata: { status: updatedInvoice.status },
    });

    res.json(serializeInvoiceResult(updatedInvoice));
  } catch (error) {
    console.error("Issue invoice error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const recordPayment = async (req, res) => {
  try {
    const { amountPaid, paymentMethod, notes } = req.body;
    const paymentAmount = Number(amountPaid);

    if (!paymentAmount || paymentAmount <= 0) {
      return res.status(400).json({ message: "Valid payment amount required" });
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: { patient: { select: { clinicId: true } } },
    });
    if (!invoice || invoice.patient.clinicId !== req.user.clinicId) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const existingPayments = normalizePayments(invoice.payments);
    const remainingBalance = Math.max(0, Number(invoice.balance) || 0);

    if (paymentAmount > remainingBalance) {
      return res.status(400).json({
        message: `Payment exceeds remaining balance of ${remainingBalance.toFixed(2)}`,
      });
    }

    const nextPayments = [
      ...existingPayments,
      {
        amount: paymentAmount,
        paymentMethod: paymentMethod || invoice.paymentMethod,
        notes: notes || "",
        receivedAt: new Date().toISOString(),
      },
    ];
    const nextAmountPaid = sumPayments(nextPayments);
    const balance = invoice.total - nextAmountPaid;
    const nextStatus = getInvoiceStatus({
      status: invoice.status,
      total: invoice.total,
      amountPaid: nextAmountPaid,
      dueDate: invoice.dueDate,
    });
    const updatedInvoice = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        payments: nextPayments,
        amountPaid: nextAmountPaid,
        balance,
        paymentMethod: paymentMethod || invoice.paymentMethod,
        status: nextStatus,
        ...(notes
          ? {
              notes: `${invoice.notes || ""}${invoice.notes ? "\n" : ""}Payment recorded: ${notes}`,
            }
          : {}),
      },
      include: invoiceInclude,
    });

    await logAuditEvent(req, {
      action: "invoice.payment.recorded",
      resourceType: "invoice",
      resourceId: updatedInvoice.id,
      patientId: updatedInvoice.patientId,
      metadata: {
        paymentAmount,
        amountPaidTotal: updatedInvoice.amountPaid,
        balance: updatedInvoice.balance,
        paymentMethod: updatedInvoice.paymentMethod,
        status: updatedInvoice.status,
      },
    });

    res.json(serializeInvoiceResult(updatedInvoice));
  } catch (error) {
    console.error("Record payment error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

export const getInvoiceReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const invoices = await prisma.invoice.findMany({
      where: {
        patient: {
          clinicId: req.user.clinicId,
        },
        status: { not: "draft" },
        ...((startDate || endDate)
          ? {
              invoiceDate: {
                ...(startDate ? { gte: new Date(startDate) } : {}),
                ...(endDate ? { lte: new Date(endDate) } : {}),
              },
            }
          : {}),
      },
    });

    const report = {
      totalInvoices: invoices.length,
      totalRevenue: invoices.reduce((sum, invoice) => sum + invoice.total, 0),
      totalPaid: invoices.reduce((sum, invoice) => sum + invoice.amountPaid, 0),
      totalOutstanding: invoices.reduce(
        (sum, invoice) => sum + invoice.balance,
        0,
      ),
      paidInvoices: invoices.filter((invoice) => invoice.status === "paid")
        .length,
      overdueInvoices: invoices.filter((invoice) => invoice.status === "overdue")
        .length,
    };

    res.json(report);
  } catch (error) {
    console.error("Get invoice report error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};
