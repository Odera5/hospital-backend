import crypto from "crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { prisma } from "../lib/prisma.js";

const isProduction = String(process.env.NODE_ENV || "").trim() === "production";
let cleanupTimer;

const incrementCounter = async (key, windowMs) => {
  const [counter] = await prisma.$queryRaw`
    INSERT INTO "RateLimitCounter" ("key", "hits", "resetAt")
    VALUES (${key}, 1, NOW() + (${windowMs} * INTERVAL '1 millisecond'))
    ON CONFLICT ("key") DO UPDATE
    SET
      "hits" = CASE
        WHEN "RateLimitCounter"."resetAt" <= NOW() THEN 1
        ELSE "RateLimitCounter"."hits" + 1
      END,
      "resetAt" = CASE
        WHEN "RateLimitCounter"."resetAt" <= NOW()
          THEN NOW() + (${windowMs} * INTERVAL '1 millisecond')
        ELSE "RateLimitCounter"."resetAt"
      END
    RETURNING "hits", "resetAt"
  `;

  return {
    totalHits: Number(counter.hits),
    resetTime: counter.resetAt,
  };
};

class PostgresRateLimitStore {
  constructor(id, windowMs) {
    this.prefix = `bhf:ratelimit:${id}:`;
    this.windowMs = windowMs;
    this.localKeys = false;
  }

  async increment(key) {
    return incrementCounter(`${this.prefix}${key}`, this.windowMs);
  }

  async decrement(key) {
    await prisma.$executeRaw`
      UPDATE "RateLimitCounter"
      SET "hits" = GREATEST("hits" - 1, 0)
      WHERE "key" = ${`${this.prefix}${key}`}
    `;
  }

  async resetKey(key) {
    await prisma.$executeRaw`
      DELETE FROM "RateLimitCounter"
      WHERE "key" = ${`${this.prefix}${key}`}
    `;
  }

  async get(key) {
    const [counter] = await prisma.$queryRaw`
      SELECT "hits", "resetAt"
      FROM "RateLimitCounter"
      WHERE "key" = ${`${this.prefix}${key}`}
        AND "resetAt" > NOW()
    `;

    if (!counter) {
      return undefined;
    }

    return {
      totalHits: Number(counter.hits),
      resetTime: counter.resetAt,
    };
  }
}

export const startRateLimitCleanup = () => {
  if (!isProduction || cleanupTimer) {
    return;
  }

  const cleanupExpiredCounters = async () => {
    try {
      await prisma.$executeRaw`
        DELETE FROM "RateLimitCounter"
        WHERE "resetAt" < NOW() - INTERVAL '1 day'
      `;
    } catch (error) {
      console.error("Failed to clean up expired rate-limit counters:", error);
    }
  };

  void cleanupExpiredCounters();
  cleanupTimer = setInterval(cleanupExpiredCounters, 60 * 60 * 1000);
  cleanupTimer.unref();
};

export const stopRateLimitCleanup = () => {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  }
};

const getEmailKey = (req) => {
  const email = String(
    req.body?.email || req.body?.adminEmail || req.body?.clinicEmail || "",
  )
    .trim()
    .toLowerCase();

  if (!email) {
    return `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || "unknown")}`;
  }

  return `email:${crypto.createHash("sha256").update(email).digest("hex")}`;
};

const getResetTokenKey = (req) => {
  const token = String(req.body?.token || "").trim();

  if (!token) {
    return `ip:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || "unknown")}`;
  }

  return `reset:${crypto.createHash("sha256").update(token).digest("hex")}`;
};

const getUserKey = (req) => `user:${req.user?.id || "anonymous"}`;

const createStore = (id, windowMs) => {
  if (!isProduction) {
    return undefined;
  }

  return new PostgresRateLimitStore(id, windowMs);
};

export const canSendNewClinicAdminAlert = async () => {
  if (!isProduction) {
    return true;
  }

  const { totalHits } = await incrementCounter(
    "bhf:email-budget:new-clinic-admin-alerts",
    60 * 60 * 1000,
  );

  return totalHits <= 10;
};

const createLimiter = ({
  id,
  windowMs,
  max,
  message,
  skipSuccessfulRequests = false,
  keyGenerator,
}) =>
  rateLimit({
    windowMs,
    max,
    skipSuccessfulRequests,
    ...(keyGenerator ? { keyGenerator } : {}),
    ...(isProduction ? { store: createStore(id, windowMs) } : {}),
    message: { message },
    standardHeaders: true,
    legacyHeaders: false,
  });

const createIpAndTargetLimiters = ({
  id,
  windowMs,
  ipMax,
  targetMax,
  message,
  targetKey,
}) => [
  createLimiter({ id: `${id}-ip`, windowMs, max: ipMax, message }),
  createLimiter({
    id: `${id}-target`,
    windowMs,
    max: targetMax,
    message,
    keyGenerator: targetKey,
  }),
];

/**
 * Global API limiter. express-rate-limit keys by req.ip, including IPv6 handling.
 */
export const apiLimiter = createLimiter({
  id: "api",
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 1000 : 2500,
  message: isProduction
    ? "Too many requests from this IP, please try again later."
    : "Too many development requests. Please wait a moment and try again.",
});

/**
 * Bound authenticated API traffic per account as well as by source IP.
 * This middleware is invoked after `protect` identifies the user.
 */
export const authenticatedApiLimiter = createLimiter({
  id: "authenticated-api-user",
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 1500 : 3000,
  message: "Too many API requests for this account. Please try again later.",
  keyGenerator: getUserKey,
});

/**
 * Login limits apply independently to the source IP and normalized email.
 * Failed attempts only count toward either limit.
 */
export const loginLimiter = [
  createLimiter({
    id: "login-ip",
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 30 : 100,
    skipSuccessfulRequests: true,
    message:
      "Too many failed login attempts. Please wait 15 minutes before trying again.",
  }),
  createLimiter({
    id: "login-email",
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 8 : 25,
    skipSuccessfulRequests: true,
    message:
      "Too many failed login attempts for this account. Please wait 15 minutes before trying again.",
    keyGenerator: getEmailKey,
  }),
];

/**
 * Registration has independent IP and admin-email limits because it creates
 * accounts and sends verification and alert emails.
 */
export const registrationLimiter = createIpAndTargetLimiters({
  id: "registration",
  windowMs: 60 * 60 * 1000,
  ipMax: isProduction ? 3 : 10,
  targetMax: isProduction ? 3 : 10,
  message: "Too many account registration attempts. Please try again later.",
  targetKey: getEmailKey,
});

/**
 * Shared recipient budget across registration, password reset, and verification
 * email routes prevents switching endpoints to evade the per-address limit.
 */
export const emailRecipientLimiter = createLimiter({
  id: "email-recipient",
  windowMs: 60 * 60 * 1000,
  max: isProduction ? 5 : 15,
  message: "Too many email requests for this address. Please try again later.",
  keyGenerator: getEmailKey,
});

/**
 * Staff account creation is bounded per source IP and authenticated actor.
 */
export const staffCreationLimiter = [
  createLimiter({
    id: "staff-create-ip",
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 30 : 100,
    message:
      "Too many staff creation requests. Please wait a few minutes before adding more accounts.",
  }),
  createLimiter({
    id: "staff-create-user",
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 20 : 60,
    message:
      "Too many staff creation requests for this account. Please wait a few minutes before adding more accounts.",
    keyGenerator: getUserKey,
  }),
];

/**
 * Email-triggering routes have separate IP and recipient limits. Changing
 * either the source IP or requested email cannot bypass the other limit.
 */
export const forgotPasswordLimiter = createIpAndTargetLimiters({
  id: "forgot-password",
  windowMs: 60 * 60 * 1000,
  ipMax: isProduction ? 10 : 30,
  targetMax: isProduction ? 3 : 10,
  message:
    "Too many password reset requests. Please check your inbox or try again in an hour.",
  targetKey: getEmailKey,
});

export const resendVerificationLimiter = createIpAndTargetLimiters({
  id: "resend-verification",
  windowMs: 60 * 60 * 1000,
  ipMax: isProduction ? 10 : 30,
  targetMax: isProduction ? 3 : 10,
  message:
    "Too many verification email requests. Please check your spam folder or try again in an hour.",
  targetKey: getEmailKey,
});

/**
 * Reset submissions are bounded per source IP and reset token.
 */
export const resetPasswordLimiter = [
  createLimiter({
    id: "reset-password-ip",
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 20 : 50,
    skipSuccessfulRequests: true,
    message:
      "Too many failed password reset attempts. Please request a new reset link.",
  }),
  createLimiter({
    id: "reset-password-token",
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 6 : 20,
    skipSuccessfulRequests: true,
    message:
      "Too many failed password reset attempts. Please request a new reset link.",
    keyGenerator: getResetTokenKey,
  }),
];

/**
 * OTP sending counts all requests; OTP verification counts failed attempts.
 */
export const sensitiveActionInitiateLimiter = [
  createLimiter({
    id: "sensitive-action-initiate-ip",
    windowMs: 60 * 60 * 1000,
    max: isProduction ? 10 : 30,
    message:
      "Too many security code requests. Please wait before requesting another code.",
  }),
  createLimiter({
    id: "sensitive-action-initiate-user",
    windowMs: 60 * 60 * 1000,
    max: isProduction ? 3 : 10,
    message:
      "Too many security code requests. Please wait before requesting another code.",
    keyGenerator: getUserKey,
  }),
];

export const sensitiveActionVerifyLimiter = [
  createLimiter({
    id: "sensitive-action-verify-ip",
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 15 : 50,
    skipSuccessfulRequests: true,
    message:
      "Too many security verification attempts. Please wait 15 minutes before trying again.",
  }),
  createLimiter({
    id: "sensitive-action-verify-user",
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 5 : 20,
    skipSuccessfulRequests: true,
    message:
      "Too many security verification attempts. Please wait 15 minutes before trying again.",
    keyGenerator: getUserKey,
  }),
];

/**
 * Backwards compatibility alias for any existing reference.
 */
export const authLimiter = loginLimiter;
