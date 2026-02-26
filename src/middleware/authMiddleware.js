// src/middleware/authorize.js
import jwt from "jsonwebtoken";

// =========================
// PROTECT ROUTE (JWT VERIFY)
// =========================
export const protect = (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    if (!authHeader) return res.status(401).json({ message: "No token provided" });

    const token = authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Token missing" });

    jwt.verify(token, process.env.JWT_SECRET || "secret123", (err, decoded) => {
      if (err) return res.status(403).json({ message: "Invalid token" });
      req.user = decoded; // { id, role, email, etc. }
      next();
    });
  } catch (err) {
    console.error("Token verification error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// =========================
// AUTHORIZE SPECIFIC ROLES
// =========================
export const authorizeRoles = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  if (!roles.includes(req.user.role)) return res.status(403).json({ message: "Forbidden" });
  next();
};
