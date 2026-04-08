import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not defined in environment variables");
}

if (!process.env.JWT_REFRESH_SECRET) {
  throw new Error("JWT_REFRESH_SECRET is not defined in environment variables");
}

const resolveUserId = (user) => user.id || user._id;

export const generateAccessToken = (user) =>
  jwt.sign(
    {
      id: resolveUserId(user),
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: "15m" },
  );

export const generateRefreshToken = (user) =>
  jwt.sign(
    {
      id: resolveUserId(user),
    },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "7d" },
  );
