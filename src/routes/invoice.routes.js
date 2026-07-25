import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { enforceSubscriptionState } from "../middleware/subscriptionStateGuard.js";
import { prisma } from "../lib/prisma.js";
import {
  getAllInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  issueInvoice,
  recordPayment,
  getInvoiceReport,
  getInvoicePatients,
  autoUpdateOverdueInvoices,
} from "../controllers/invoiceController.js";
import { validateInvoice } from "../middleware/validators.js";

const router = express.Router();

router.use(verifyToken);
router.use(enforceSubscriptionState({ allowAdminReadOnly: true }));
router.use(autoUpdateOverdueInvoices);

router.get("/", getAllInvoices);
router.get("/report", getInvoiceReport);
router.get("/patients", getInvoicePatients);
router.get("/:id", getInvoice);
router.post("/", validateInvoice, createInvoice);
router.put("/:id", validateInvoice, updateInvoice);
router.put("/:id/issue", issueInvoice);
router.put("/:id/payment", recordPayment);

router.delete("/:id", async (req, res) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        patient: {
          select: { clinicId: true, branchId: true },
        },
      },
    });

    if (
      !invoice ||
      invoice.patient?.clinicId !== req.user.clinicId ||
      invoice.patient?.branchId !== req.user.branchId
    ) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    if (invoice.amountPaid > 0) {
      return res.status(400).json({ message: "Cannot cancel an invoice with payments recorded" });
    }

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: "cancelled" },
    });

    res.json({ message: "Invoice cancelled" });
  } catch (error) {
    console.error("Delete invoice error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
