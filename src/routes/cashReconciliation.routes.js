import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { authorizeRoles } from "../middleware/authorize.js";
import { enforceSubscriptionState } from "../middleware/subscriptionStateGuard.js";
import {
  getCashReconciliations,
  reviewCashReconciliation,
} from "../controllers/cashReconciliationController.js";

const router = express.Router();

router.use(verifyToken);
router.use(authorizeRoles("admin", "branch_manager"));
router.use(enforceSubscriptionState({ allowAdminReadOnly: true }));

router.get("/", getCashReconciliations);
router.patch("/:id/review", reviewCashReconciliation);

export default router;
