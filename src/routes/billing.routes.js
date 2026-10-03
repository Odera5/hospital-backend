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
  initializeStripeCheckout,
  createStripePortalLink,
  cancelStripeSubscriptionHandler,
  verifyStripeCheckout,
} from "../controllers/billingController.js";
import {
  validatePaystackInitialization,
  validatePaystackVerify,
  validateStripeInitialization,
  validateStripeVerify,
} from "../middleware/validators.js";

const router = express.Router();

router.get(
  "/paystack/verify-public",
  validatePaystackVerify,
  verifyPaystackCheckoutPublic,
);
router.get(
  "/stripe/verify-public",
  validateStripeVerify,
  verifyStripeCheckout,
);

router.get("/", protect, authorizeRoles("admin"), getBillingOverview);
router.post(
  "/paystack/initialize",
  protect,
  authorizeRoles("admin"),
  validatePaystackInitialization,
  initializePaystackCheckout,
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

router.post(
  "/stripe/initialize",
  protect,
  authorizeRoles("admin"),
  validateStripeInitialization,
  initializeStripeCheckout,
);
router.get(
  "/stripe/portal",
  protect,
  authorizeRoles("admin"),
  createStripePortalLink,
);
router.post(
  "/stripe/cancel",
  protect,
  authorizeRoles("admin"),
  cancelStripeSubscriptionHandler,
);
router.get(
  "/stripe/verify",
  protect,
  authorizeRoles("admin"),
  validateStripeVerify,
  verifyStripeCheckout,
);

router.post("/upgrade", protect, authorizeRoles("admin"), upgradeSubscription);

export default router;

