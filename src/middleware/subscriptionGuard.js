import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Middleware to ensure the user's clinic is on a PRO or ENTERPRISE_AI plan.
 * Must be used AFTER verifyToken.
 */
export const requireProOrEnterprise = async (req, res, next) => {
  try {
    if (!req.user || !req.user.clinicId) {
      return res.status(401).json({ message: "Unauthorized - No clinic context found." });
    }

    const clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
      select: { id: true, plan: true, subscriptionEnds: true }
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found." });
    }

    if (clinic.plan === "PRO" && clinic.subscriptionEnds && new Date(clinic.subscriptionEnds) < new Date()) {
      await prisma.clinic.update({
        where: { id: clinic.id },
        data: { plan: "FREE" }
      });
      clinic.plan = "FREE";
    }

    if (clinic.plan === "FREE") {
      return res.status(403).json({ 
        message: "This feature requires a Pro or Enterprise subscription.",
        errorCode: "UPGRADE_REQUIRED"
      });
    }

    next();
  } catch (error) {
    console.error("Error checking subscription:", error);
    res.status(500).json({ message: "Server error validating subscription status." });
  }
};
