import rateLimit from "express-rate-limit";

const isProduction = process.env.NODE_ENV === "production";

/**
 * 1. Global API Limiter
 * Applied across all `/api` routes in app.js.
 * Protects server resources from abuse/DDoS while providing generous headroom
 * for Single Page Application (SPA) dashboard navigation and concurrent calls.
 *
 * Production: 1,000 requests per 15 minutes (~66 req/min)
 * Development: 10,000 requests per 15 minutes
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 1000 : 10000,
  message: {
    message: isProduction
      ? "Too many requests from this IP, please try again later."
      : "Too many development requests. Please wait a moment and try again.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 2. Login Limiter
 * Applied to POST /api/auth/login.
 * Protects against credential stuffing and brute-forcing (OWASP).
 * Crucially, only failed attempts (4xx/5xx) are counted (`skipSuccessfulRequests: true`).
 * Legitimate users who log in successfully are not penalized or locked out.
 *
 * Production: 10 failed attempts per 15 minutes
 * Development: 100 failed attempts per 15 minutes
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 10 : 100,
  skipSuccessfulRequests: true,
  message: {
    message:
      "Too many failed login attempts from this IP. Please try again after 15 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 3. Clinic Registration Limiter
 * Applied to POST /api/auth/register-clinic.
 * Prevents automated mass-registration spam.
 * Works alongside Cloudflare Turnstile CAPTCHA and honeypot traps.
 *
 * Production: 5 registration requests per 1 hour
 * Development: 50 requests per 1 hour
 */
export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isProduction ? 5 : 50,
  message: {
    message:
      "Too many account registration attempts from this IP. Please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 4. Staff Account Creation Limiter
 * Applied to POST /api/auth/signup (authenticated admin/manager onboarding staff).
 * Allows clinic admins to batch-create multiple staff accounts (doctors, nurses)
 * during clinic onboarding without getting prematurely locked out.
 *
 * Production: 30 account creations per 15 minutes
 * Development: 100 requests per 15 minutes
 */
export const staffCreationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 30 : 100,
  message: {
    message:
      "Too many staff creation requests. Please wait a few minutes before adding more accounts.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 5. Forgot Password Limiter
 * Applied to POST /api/auth/forgot-password.
 * Prevents email inbox bombing attacks and shields transactional email quota.
 *
 * Production: 5 requests per 1 hour
 * Development: 50 requests per 1 hour
 */
export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isProduction ? 5 : 50,
  message: {
    message:
      "Too many password reset requests. Please check your inbox or try again in an hour.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 6. Password Reset Submission Limiter
 * Applied to POST /api/auth/reset-password.
 * Protects against brute-forcing password reset tokens.
 * Only failed token submissions count against the limit.
 *
 * Production: 10 failed attempts per 15 minutes
 * Development: 50 attempts per 15 minutes
 */
export const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 10 : 50,
  skipSuccessfulRequests: true,
  message: {
    message:
      "Too many failed password reset attempts. Please request a new reset link.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 7. Resend Email Verification Limiter
 * Applied to POST /api/auth/resend-verification.
 * Prevents spamming verification emails and inbox flooding.
 *
 * Production: 5 requests per 1 hour
 * Development: 50 requests per 1 hour
 */
export const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isProduction ? 5 : 50,
  message: {
    message:
      "Too many verification email requests. Please check your spam folder or try again in an hour.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 8. Sensitive OTP Action Limiter
 * Applied to POST /api/auth/clinic-profile/deactivate/initiate and verify.
 * Protects high-impact clinic deactivation actions from brute-force OTP guessing.
 * Only failed OTP attempts increment the counter.
 *
 * Production: 5 attempts per 15 minutes
 * Development: 50 attempts per 15 minutes
 */
export const sensitiveActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 5 : 50,
  skipSuccessfulRequests: true,
  message: {
    message:
      "Too many security verification attempts. Please wait 15 minutes before trying again.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Backwards compatibility alias for any existing reference.
 */
export const authLimiter = loginLimiter;
