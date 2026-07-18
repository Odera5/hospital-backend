import express from "express";
import { prisma } from "../lib/prisma.js";
import { logAuditEvent } from "../services/auditLog.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import { validateBranchPayload } from "../middleware/validators.js";
import { hasEnterpriseAccess } from "../utils/subscriptionAccess.js";
import { getAllowedActiveBranches } from "../utils/branchAccess.js";

const router = express.Router();

const slugifyBranchPart = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const buildBranchSlug = ({ name, city, area }) =>
  [city, area, name].map(slugifyBranchPart).filter(Boolean).join("-");

const serializeBranch = (branch) => ({
  id: branch.id,
  clinicId: branch.clinicId,
  name: branch.name,
  slug: branch.slug,
  country: branch.country || "",
  city: branch.city || "",
  area: branch.area || "",
  address: branch.address || "",
  phone: branch.phone || "",
  isActive: Boolean(branch.isActive),
  isPrimary: Boolean(branch.isPrimary),
  intakeEnabled: Boolean(branch.intakeEnabled),
  createdAt: branch.createdAt,
  updatedAt: branch.updatedAt,
});

const ensureEnterpriseBranchAccess = async (clinicId) => {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
  });

  if (!clinic) {
    return {
      error: { status: 404, message: "Clinic not found" },
      clinic: null,
    };
  }

  if (!hasEnterpriseAccess(clinic)) {
    return {
      error: {
        status: 403,
        code: "ENTERPRISE_REQUIRED",
        message:
          "Branch management is available only on the Enterprise plan with active access.",
      },
      clinic,
    };
  }

  return { clinic, error: null };
};

router.use(protect);

router.get("/", async (req, res) => {
  try {
    const branches =
      req.user.role === "admin"
        ? await prisma.branch.findMany({
            where: { clinicId: req.user.clinicId },
            orderBy: [
              { isPrimary: "desc" },
              { city: "asc" },
              { area: "asc" },
              { name: "asc" },
            ],
          })
        : await getAllowedActiveBranches({
            clinicId: req.user.clinicId,
            role: req.user.role,
            assignedBranchIds: req.user.assignedBranchIds,
          });

    res.json({ branches: branches.map(serializeBranch) });
  } catch (error) {
    console.error("Get branches error:", error);
    res.status(500).json({ message: "Failed to fetch branches" });
  }
});

router.post("/", authorizeRoles("admin"), validateBranchPayload, async (req, res) => {
  try {
    const { error } = await ensureEnterpriseBranchAccess(req.user.clinicId);
    if (error) {
      return res.status(error.status).json(error);
    }

    const payload = {
      name: String(req.body?.name || "").trim(),
      country: String(req.body?.country || "").trim(),
      city: String(req.body?.city || "").trim(),
      area: String(req.body?.area || "").trim(),
      address: String(req.body?.address || "").trim(),
      phone: String(req.body?.phone || "").trim(),
    };

    const slug =
      buildBranchSlug(payload) ||
      `branch-${Date.now().toString(36)}`;

    const existingBranch = await prisma.branch.findFirst({
      where: {
        clinicId: req.user.clinicId,
        slug,
      },
      select: { id: true, name: true, city: true, area: true },
    });

    if (existingBranch) {
      return res.status(400).json({
        code: "BRANCH_ALREADY_EXISTS",
        message: `A branch already exists for ${payload.city} - ${payload.area}. If this is the same clinic branch, use the existing branch instead.`,
      });
    }

    const branch = await prisma.branch.create({
      data: {
        clinicId: req.user.clinicId,
        ...payload,
        slug,
      },
    });

    await logAuditEvent(req, {
      action: "branch.create",
      resourceType: "branch",
      resourceId: branch.id,
      metadata: {
        name: branch.name,
        city: branch.city,
      },
    });

    res.status(201).json({
      message: "Branch created successfully",
      branch: serializeBranch(branch),
    });
  } catch (error) {
    console.error("Create branch error:", error);
    res.status(500).json({ message: "Failed to create branch" });
  }
});

router.put("/:id", authorizeRoles("admin"), validateBranchPayload, async (req, res) => {
  try {
    const { error } = await ensureEnterpriseBranchAccess(req.user.clinicId);
    if (error) {
      return res.status(error.status).json(error);
    }

    const existingBranch = await prisma.branch.findFirst({
      where: {
        id: req.params.id,
        clinicId: req.user.clinicId,
      },
    });

    if (!existingBranch) {
      return res.status(404).json({ message: "Branch not found" });
    }

    const payload = {
      name: String(req.body?.name || "").trim(),
      country: String(req.body?.country || "").trim(),
      city: String(req.body?.city || "").trim(),
      area: String(req.body?.area || "").trim(),
      address: String(req.body?.address || "").trim(),
      phone: String(req.body?.phone || "").trim(),
    };

    const slug =
      buildBranchSlug(payload) ||
      existingBranch.slug;

    const duplicateBranch = await prisma.branch.findFirst({
      where: {
        clinicId: req.user.clinicId,
        slug,
        id: { not: existingBranch.id },
      },
      select: { id: true },
    });

    if (duplicateBranch) {
      return res.status(400).json({
        code: "BRANCH_ALREADY_EXISTS",
        message: `A branch already exists for ${payload.city} - ${payload.area}. If this is the same clinic branch, use the existing branch instead.`,
      });
    }

    const branch = await prisma.branch.update({
      where: { id: existingBranch.id },
      data: {
        ...payload,
        slug,
      },
    });

    await logAuditEvent(req, {
      action: "branch.update",
      resourceType: "branch",
      resourceId: branch.id,
      metadata: {
        updatedFields: Object.keys(req.body),
      },
    });

    res.json({
      message: "Branch updated successfully",
      branch: serializeBranch(branch),
    });
  } catch (error) {
    console.error("Update branch error:", error);
    res.status(500).json({ message: "Failed to update branch" });
  }
});

router.patch("/:id/status", authorizeRoles("admin"), async (req, res) => {
  try {
    const { error } = await ensureEnterpriseBranchAccess(req.user.clinicId);
    if (error) {
      return res.status(error.status).json(error);
    }

    const existingBranch = await prisma.branch.findFirst({
      where: {
        id: req.params.id,
        clinicId: req.user.clinicId,
      },
    });

    if (!existingBranch) {
      return res.status(404).json({ message: "Branch not found" });
    }

    if (existingBranch.isPrimary && req.body?.isActive === false) {
      return res.status(400).json({
        message: "The primary branch cannot be deactivated.",
      });
    }

    const branch = await prisma.branch.update({
      where: { id: existingBranch.id },
      data: {
        isActive: Boolean(req.body?.isActive),
      },
    });

    await logAuditEvent(req, {
      action: "branch.update",
      resourceType: "branch",
      resourceId: branch.id,
      metadata: {
        isActive: branch.isActive,
      },
    });

    res.json({
      message: branch.isActive
        ? "Branch activated successfully"
        : "Branch deactivated successfully",
      branch: serializeBranch(branch),
    });
  } catch (error) {
    console.error("Update branch status error:", error);
    res.status(500).json({ message: "Failed to update branch status" });
  }
});

export default router;
