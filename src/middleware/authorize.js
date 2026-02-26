// src/middleware/authorize.js
import jwt from "jsonwebtoken";
import User from "../models/user.model.js";

/**
 * Protect routes by verifying JWT token.
 */
export const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Not authorized, token missing" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Token not provided" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password -refreshToken");

    if (!user) return res.status(401).json({ message: "User not found" });

    req.user = user;
    next();
  } catch (err) {
    console.error("JWT error:", err.message);

    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Access token expired" });
    }

    res.status(401).json({ message: "Not authorized, token invalid" });
  }
};

/**
 * Role-based authorization middleware.
 * Accepts multiple roles.
 */
export const authorizeRoles = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });

  if (!roles.includes(req.user.role)) {
    return res
      .status(403)
      .json({ message: `Role (${req.user.role}) not authorized to access this resource` });
  }

  next();
};