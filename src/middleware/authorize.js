import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import {
  getAllowedActiveBranches,
  resolveActiveBranch,
  serializeBranch,
  STAFF_BRANCH_ACCESS_MESSAGE,
} from "../utils/branchAccess.js";
import { hasEnterpriseAccess } from "../utils/subscriptionAccess.js";

export const protect = async (req, res, next) => {
  try {
    if (req.user) {
      return next();
    }

    let token = req.cookies?.accessToken;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        token = authHeader.split(" ")[1];
      }
    }

    if (!token) {
      return res.status(401).json({ message: "Not authorized, token missing" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const users = await prisma.$queryRaw`
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        u."assignedBranchIds",
        u."isActive",
        u."emailVerified",
        u."clinicId",
        u."refreshToken",
        c."isActive" AS "clinicIsActive",
        c."plan" AS "clinicPlan",
        c."subscriptionEnds" AS "clinicSubscriptionEnds",
        c."paystackSubscriptionStatus" AS "clinicPaystackSubscriptionStatus"
      FROM "User" u
      INNER JOIN "Clinic" c ON c.id = u."clinicId"
      WHERE u.id = ${decoded.id}
      LIMIT 1
    `;
    const user = users[0] ?? null;

    if (!user) return res.status(401).json({ message: "User not found" });
    if (!user.isActive) {
      return res.status(403).json({ message: "Your staff account has been deactivated" });
    }
    if (!user.emailVerified) {
      return res.status(403).json({
        message:
          "Please confirm your email address to activate your account before signing in.",
      });
    }
    if (!user.clinicIsActive) {
      return res.status(403).json({
        message: "Your clinic account has been deactivated. Contact support for reactivation.",
      });
    }

    user.clinic = {
      id: user.clinicId,
      isActive: Boolean(user.clinicIsActive),
      plan: user.clinicPlan || "PRO",
      subscriptionEnds: user.clinicSubscriptionEnds || null,
      paystackSubscriptionStatus: user.clinicPaystackSubscriptionStatus || null,
    };

    const branches = await getAllowedActiveBranches({
      clinicId: user.clinicId,
      role: user.role,
      assignedBranchIds: user.assignedBranchIds,
    });

    const requestedBranchId = String(
      req.headers?.["x-branch-id"] || req.query?.branchId || "",
    ).trim();

    if (branches.length === 0 && user.role !== "admin") {
      return res.status(403).json({
        message: STAFF_BRANCH_ACCESS_MESSAGE,
      });
    }

    if (branches.length > 0) {
      const primaryBranch = branches.find((b) => b.isPrimary) || branches[0];
      const hasEnterprise = hasEnterpriseAccess(user.clinic);
      const targetBranchId = hasEnterprise ? requestedBranchId : (primaryBranch?.id || "");

      const { activeBranch } = resolveActiveBranch(branches, targetBranchId);

      if (targetBranchId && !activeBranch) {
        return res.status(403).json({
          message: "The selected branch is not available for this staff account.",
        });
      }

      user.branchId = activeBranch?.id || null;
      user.branch = serializeBranch(activeBranch);
      user.availableBranches = branches.map(serializeBranch);
    }

    if (decoded.sessionId) {
      if (!user.refreshToken) {
        return res.status(401).json({ message: "Session invalid. Please log in again." });
      }
      const currentSessionId = user.refreshToken.substring(user.refreshToken.length - 15);
      if (decoded.sessionId !== currentSessionId) {
        return res.status(401).json({ message: "Session expired. You logged in on another device." });
      }
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
