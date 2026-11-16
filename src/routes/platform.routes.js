import express from "express";
import { prisma } from "../lib/prisma.js";
import { protect } from "../middleware/authorize.js";
import { getTrialFollowUpClinics } from "../services/trialFollowUpService.js";

const router = express.Router();

router.use(protect);

router.get("/trial-follow-ups", async (req, res) => {
  const allowedEmails = (process.env.PLATFORM_ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (allowedEmails.length === 0) {
    return res.status(503).json({
      message: "Platform staff access is not configured.",
    });
  }

  if (!allowedEmails.includes(String(req.user.email || "").toLowerCase())) {
    return res.status(403).json({ message: "You are not authorized to view this list." });
  }

  try {
    const followUps = await getTrialFollowUpClinics();
    const clinicIds = followUps.map(({ clinic }) => clinic.id);
    const notifications = clinicIds.length
      ? await prisma.trialFollowUpNotification.findMany({
          where: { clinicId: { in: clinicIds } },
          select: {
            clinicId: true,
            subscriptionEnd: true,
            milestone: true,
            status: true,
            attempts: true,
            lastAttemptAt: true,
            sentAt: true,
          },
          orderBy: { createdAt: "desc" },
        })
      : [];

    res.json({
      followUps: followUps.map((followUp) => ({
        clinic: followUp.clinic,
        daysRemaining: followUp.daysRemaining,
        daysExpired: followUp.daysExpired,
        notifications: notifications
          .filter(
            (notification) =>
              notification.clinicId === followUp.clinic.id &&
              notification.subscriptionEnd.getTime() ===
                followUp.clinic.subscriptionEnds.getTime(),
          )
          .map(({ clinicId, subscriptionEnd, ...notification }) => notification),
      })),
    });
  } catch (error) {
    console.error("Fetch platform trial follow-ups error:", error);
    res.status(500).json({ message: "Failed to fetch trial follow-ups." });
  }
});

export default router;
