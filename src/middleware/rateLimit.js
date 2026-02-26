import rateLimit from "express-rate-limit";

// Limit requests to 100 per 15 minutes per IP
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per window
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
});
