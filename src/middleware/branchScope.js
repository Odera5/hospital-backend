import { prisma } from "../lib/prisma.js";
import {
  getAllowedActiveBranches,
  resolveActiveBranch,
  serializeBranch,
  STAFF_BRANCH_ACCESS_MESSAGE,
} from "../utils/branchAccess.js";

const BRANCH_HEADER_NAME = "x-branch-id";

export const resolveBranchScope = async (req, res, next) => {
  try {
    if (!req.user?.clinicId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const requestedBranchId = String(
      req.headers?.[BRANCH_HEADER_NAME] || req.query?.branchId || "",
    ).trim();

    const branches = await getAllowedActiveBranches({
      clinicId: req.user.clinicId,
      role: req.user.role,
      assignedBranchIds: req.user.assignedBranchIds,
    });

    if (branches.length === 0 && req.user.role !== "admin") {
      return res.status(403).json({
        message: STAFF_BRANCH_ACCESS_MESSAGE,
      });
    }

    if (branches.length === 0) {
      return res.status(404).json({
        message: "No active branch is configured for this clinic.",
      });
    }

    const { activeBranch } = resolveActiveBranch(branches, requestedBranchId);

    if (requestedBranchId && !activeBranch) {
      return res.status(403).json({
        message: "The selected branch is not available for this staff account.",
      });
    }

    req.user.branchId = activeBranch.id;
    req.user.branch = serializeBranch(activeBranch);
    req.user.availableBranches = branches.map(serializeBranch);

    next();
  } catch (error) {
    console.error("Resolve branch scope error:", error);
    res.status(500).json({ message: "Failed to resolve branch scope" });
  }
};

export const serializeBranchScope = (req) => ({
  activeBranch: req.user?.branch || null,
  branches: Array.isArray(req.user?.availableBranches)
    ? req.user.availableBranches
    : [],
});
