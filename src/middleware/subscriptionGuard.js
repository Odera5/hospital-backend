import { prisma } from "../lib/prisma.js";
import {
  hasActiveProAccess,
  getUpgradeRequiredMessage,
} from "../utils/subscriptionAccess.js";

/**
 * Middleware to ensure the user's clinic still has active Pro access.
 * Must be used AFTER verifyToken.
 */
export const requireProOrEnterprise = async (req, res, next) => {
  try {
    if (!req.user || !req.user.clinicId) {
      return res.status(401).json({ message: "Unauthorized - No clinic context found." });
    }

    const clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
      select: {
        id: true,
        plan: true,
        subscriptionEnds: true,
        paystackSubscriptionStatus: true,
      }
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found." });
    }

    if (!hasActiveProAccess(clinic)) {
      return res.status(403).json({
        message: getUpgradeRequiredMessage(),
        errorCode: "UPGRADE_REQUIRED"
      });
    }

    next();
  } catch (error) {
    console.error("Error checking subscription:", error);
    res.status(500).json({ message: "Server error validating subscription status." });
  }
};
