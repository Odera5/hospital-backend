import express from "express";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import {
  cancelPaystackSubscription,
  getBillingOverview,
  getPaystackManageLink,
  initializePaystackCheckout,
  verifyPaystackCheckout,
  verifyPaystackCheckoutPublic,
} from "../controllers/billingController.js";

const router = express.Router();

router.get("/paystack/verify-public", verifyPaystackCheckoutPublic);

router.get("/", protect, authorizeRoles("admin"), getBillingOverview);
router.post(
  "/paystack/initialize",
  protect,
  authorizeRoles("admin"),
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
  verifyPaystackCheckout,
);
router.post(
  "/paystack/cancel",
  protect,
  authorizeRoles("admin"),
  cancelPaystackSubscription,
);

export default router;
