import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { authorizeBillingAccess, authorizeRoles } from "../middleware/authorize.js";
import { enforceSubscriptionState } from "../middleware/subscriptionStateGuard.js";
import {
  getCashReconciliations,
  submitCashReconciliation,
  reviewCashReconciliation,
} from "../controllers/cashReconciliationController.js";
import {
  getAllInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  issueInvoice,
  recordPayment,
  reversePayment,
  cancelInvoice,
  getInvoiceReport,
  getInvoicePatients,
  autoUpdateOverdueInvoices,
} from "../controllers/invoiceController.js";
import { validateInvoice } from "../middleware/validators.js";

const router = express.Router();

router.use(verifyToken);
router.use(authorizeBillingAccess);
router.use(enforceSubscriptionState({ allowAdminReadOnly: true }));
router.use(autoUpdateOverdueInvoices);

router.get("/", getAllInvoices);
router.get("/report", getInvoiceReport);
router.get("/patients", getInvoicePatients);
router.get("/cash-reconciliations", getCashReconciliations);
router.post("/cash-reconciliations", submitCashReconciliation);
router.patch(
  "/cash-reconciliations/:id/review",
  authorizeRoles("admin"),
  reviewCashReconciliation,
);
router.get("/:id", getInvoice);
router.post("/", validateInvoice, createInvoice);
router.put("/:id", validateInvoice, updateInvoice);
router.put("/:id/issue", issueInvoice);
router.post("/:id/payments", recordPayment);
router.post(
  "/:id/payments/:paymentId/reverse",
  authorizeRoles("admin"),
  reversePayment,
);
router.delete("/:id", authorizeRoles("admin"), cancelInvoice);

export default router;
