import express from "express";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import {
  cancelPaystackSubscription,
  getBillingOverview,
  getPaystackManageLink,
  initializePaystackCheckout,
  resumePaystackSubscription,
  verifyPaystackCheckout,
  verifyPaystackCheckoutPublic,
  upgradeSubscription,
} from "../controllers/billingController.js";
import {
  validatePaystackInitialization,
  validatePaystackVerify,
} from "../middleware/validators.js";

const router = express.Router();

router.get(
  "/paystack/verify-public",
  validatePaystackVerify,
  verifyPaystackCheckoutPublic,
);

router.get("/", protect, authorizeRoles("admin"), getBillingOverview);
router.post(
  "/paystack/initialize",
  protect,
  authorizeRoles("admin"),
  validatePaystackInitialization,
  initializePaystackCheckout,
  resumePaystackSubscription,
);
router.get(
  "/paystack/manage-link",
  protect,
  authorizeRoles("admin"),
  getPaystackManageLink,
);
router.get(
  "/paystack/verify",
  protect,
  authorizeRoles("admin"),
  validatePaystackVerify,
  verifyPaystackCheckout,
);
router.post(
  "/paystack/cancel",
  protect,
  authorizeRoles("admin"),
  cancelPaystackSubscription,
);
router.post(
  "/paystack/resume",
  protect,
  authorizeRoles("admin"),
  resumePaystackSubscription,
);

router.post("/upgrade", protect, authorizeRoles("admin"), upgradeSubscription);

export default router;
