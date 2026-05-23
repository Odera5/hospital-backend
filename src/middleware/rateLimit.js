import rateLimit from "express-rate-limit";

const isProduction = process.env.NODE_ENV === "production";

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 100 : 5000,
  message: {
    message: isProduction
      ? "Too many requests from this IP, please try again later."
      : "Too many development requests. Please wait a moment and try again.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isProduction ? 5 : 50, // Limit each IP to 5 auth requests per `window` (here, per 15 minutes) in prod, 50 in dev
  message: {
    message: "Too many authentication attempts from this IP, please try again after 15 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
