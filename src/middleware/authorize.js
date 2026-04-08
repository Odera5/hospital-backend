import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";

export const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (
      !authHeader ||
      typeof authHeader !== "string" ||
      !authHeader.startsWith("Bearer ")
    ) {
      return res.status(401).json({ message: "Not authorized, token missing" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Token not provided" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const users = await prisma.$queryRaw`
      SELECT id, name, email, role, "isActive"
      FROM "User"
      WHERE id = ${decoded.id}
      LIMIT 1
    `;
    const user = users[0] ?? null;

    if (!user) return res.status(401).json({ message: "User not found" });
    if (!user.isActive) {
      return res.status(403).json({ message: "Your staff account has been deactivated" });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("JWT error:", error.message);

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Access token expired" });
    }

    res.status(401).json({ message: "Not authorized, token invalid" });
  }
};

export const authorizeRoles = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });

  if (!roles.includes(req.user.role)) {
    return res
      .status(403)
      .json({
        message: `Role (${req.user.role}) not authorized to access this resource`,
      });
  }

  next();
};
