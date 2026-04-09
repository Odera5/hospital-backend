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
  skip: () => !isProduction,
});
