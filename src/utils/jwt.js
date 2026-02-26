import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

// ============================
// Validate environment variables
// ============================

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not defined in environment variables");
}

if (!process.env.JWT_REFRESH_SECRET) {
  throw new Error("JWT_REFRESH_SECRET is not defined in environment variables");
}

// ============================
// Generate Access Token (15 mins)
// ============================

export const generateAccessToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "15m" }
  );
};

// ============================
// Generate Refresh Token (7 days)
// ============================

export const generateRefreshToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
    },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "7d" }
  );
};