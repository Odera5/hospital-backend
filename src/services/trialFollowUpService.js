import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { sendAdminTrialFollowUpDigest } from "./emailVerification.js";
import { notifyAdminOperationalIssue } from "./platformAlertService.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FOLLOW_UP_WINDOW_DAYS = 30;
const TRIAL_WINDOW_DAYS = 14;
const NOTIFICATION_LEASE_MS = 10 * 60 * 1000;

let workerIntervalId = null;
let activeJobPromise = null;

export const getTrialFollowUpMilestone = (daysRemaining) => {
  if (daysRemaining <= 0) return "expired";
  if (daysRemaining <= 1) return "1_day";
  if (daysRemaining <= 3) return "3_days";
  if (daysRemaining <= 7) return "7_days";
  return null;
};

const isUniqueConstraintError = (error) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

const isEligibleTrialWhere = (clinicId, subscriptionEnd) => ({
  id: clinicId,
  isActive: true,
  plan: { in: ["PRO", "ENTERPRISE"] },
  subscriptionEnds: subscriptionEnd,
  paystackSubscriptionStatus: null,
  paystackSubscriptionCode: null,
  subscriptionHistory: { none: {} },
});

export const getTrialFollowUpClinics = async (now = new Date()) => {
  const start = new Date(now.getTime() - FOLLOW_UP_WINDOW_DAYS * DAY_MS);
  const end = new Date(now.getTime() + TRIAL_WINDOW_DAYS * DAY_MS);
  const clinics = await prisma.clinic.findMany({
    where: {
      isActive: true,
      plan: { in: ["PRO", "ENTERPRISE"] },
      subscriptionEnds: { gte: start, lte: end },
      paystackSubscriptionStatus: null,
      paystackSubscriptionCode: null,
      subscriptionHistory: { none: {} },
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      contactPerson: true,
      plan: true,
      createdAt: true,
      subscriptionEnds: true,
      users: {
        where: { role: "admin", isActive: true },
        select: { name: true, email: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
    orderBy: { subscriptionEnds: "asc" },
  });

  return clinics.map((clinic) => {
    const daysRemaining = Math.ceil(
      (clinic.subscriptionEnds.getTime() - now.getTime()) / DAY_MS,
    );
    const { users, ...clinicDetails } = clinic;
    return {
      clinic: {
        ...clinicDetails,
        adminUser: users[0] || null,
      },
      daysRemaining,
      daysExpired: Math.max(
        0,
        Math.ceil(
          -(clinic.subscriptionEnds.getTime() - now.getTime()) / DAY_MS,
        ),
      ),
      milestone: getTrialFollowUpMilestone(daysRemaining),
    };
  });
};

const claimNotification = async ({ clinicId, subscriptionEnd, milestone }) => {
  let notification;
  try {
    notification = await prisma.trialFollowUpNotification.create({
      data: { clinicId, subscriptionEnd, milestone },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    notification = await prisma.trialFollowUpNotification.findUnique({
      where: {
        clinicId_subscriptionEnd_milestone: {
          clinicId,
          subscriptionEnd,
          milestone,
        },
      },
    });
    if (!notification) throw error;
  }

  const now = new Date();
  const claim = await prisma.trialFollowUpNotification.updateMany({
    where: {
      id: notification.id,
      OR: [
        { status: { in: ["pending", "failed"] } },
        {
          status: "sending",
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        },
      ],
    },
    data: {
      status: "sending",
      attempts: { increment: 1 },
      lastAttemptAt: now,
      lockedUntil: new Date(now.getTime() + NOTIFICATION_LEASE_MS),
      lastError: "",
    },
  });

  if (claim.count === 0) return null;
  return notification.id;
};

const runDailyTrialFollowUpDigest = async (now) => {
  try {
    const candidates = await getTrialFollowUpClinics(now);
    const claimedFollowUps = [];

    for (const candidate of candidates) {
      if (!candidate.milestone) continue;

      const currentClinic = await prisma.clinic.findFirst({
        where: isEligibleTrialWhere(
          candidate.clinic.id,
          candidate.clinic.subscriptionEnds,
        ),
        select: { id: true },
      });
      if (!currentClinic) continue;

      const notificationId = await claimNotification({
        clinicId: candidate.clinic.id,
        subscriptionEnd: candidate.clinic.subscriptionEnds,
        milestone: candidate.milestone,
      });
      if (notificationId) {
        claimedFollowUps.push({ ...candidate, notificationId });
      }
    }

    if (claimedFollowUps.length === 0) return;

    const notificationIds = claimedFollowUps.map((item) => item.notificationId);
    try {
      await sendAdminTrialFollowUpDigest(claimedFollowUps);
      await prisma.trialFollowUpNotification.updateMany({
        where: { id: { in: notificationIds }, status: "sending" },
        data: {
          status: "sent",
          sentAt: new Date(),
          lockedUntil: null,
          lastError: "",
        },
      });
      console.log(
        `[Trial Follow-up Worker] Sent digest for ${claimedFollowUps.length} clinic(s).`,
      );
    } catch (error) {
      console.error("[Trial Follow-up Worker] Failed to send digest:", error);
      void notifyAdminOperationalIssue("trial follow-up email delivery");
      try {
        await prisma.trialFollowUpNotification.updateMany({
          where: { id: { in: notificationIds }, status: "sending" },
          data: {
            status: "failed",
            lockedUntil: null,
            lastError: String(error?.message || error).slice(0, 1000),
          },
        });
      } catch (updateError) {
        console.error(
          "[Trial Follow-up Worker] Failed to record notification failure:",
          updateError,
        );
        void notifyAdminOperationalIssue("trial follow-up notification storage");
      }
    }
  } catch (error) {
    console.error("[Trial Follow-up Worker] Daily check failed:", error);
    void notifyAdminOperationalIssue("trial follow-up worker");
  }
};

export const sendDailyTrialFollowUpDigest = (now = new Date()) => {
  if (activeJobPromise) return activeJobPromise;

  activeJobPromise = runDailyTrialFollowUpDigest(now).finally(() => {
    activeJobPromise = null;
  });
  return activeJobPromise;
};

export const startTrialFollowUpWorker = () => {
  if (workerIntervalId) return;

  sendDailyTrialFollowUpDigest();
  workerIntervalId = setInterval(
    () => sendDailyTrialFollowUpDigest(),
    DAY_MS,
  );
  console.log("Trial follow-up worker started.");
};

export const stopTrialFollowUpWorker = async () => {
  if (workerIntervalId) {
    clearInterval(workerIntervalId);
    workerIntervalId = null;
  }
  if (activeJobPromise) await activeJobPromise;
};
