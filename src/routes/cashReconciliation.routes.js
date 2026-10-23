import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { authorizeRoles } from "../middleware/authorize.js";
import { enforceSubscriptionState } from "../middleware/subscriptionStateGuard.js";
import {
  getCashReconciliations,
  getPendingCashReconciliationCount,
  reviewCashReconciliation,
  respondToFlaggedCashReconciliation,
  resolveFlaggedCashReconciliation,
} from "../controllers/cashReconciliationController.js";

const router = express.Router();

router.use(verifyToken);
router.patch(
  "/:id/respond",
  enforceSubscriptionState({ allowAdminReadOnly: true }),
  respondToFlaggedCashReconciliation,
);
router.use(authorizeRoles("admin", "branch_manager"));
router.use(enforceSubscriptionState({ allowAdminReadOnly: true }));

router.get("/pending-count", getPendingCashReconciliationCount);
router.get("/", getCashReconciliations);
router.patch("/:id/review", reviewCashReconciliation);
router.patch("/:id/resolve", resolveFlaggedCashReconciliation);

export default router;
