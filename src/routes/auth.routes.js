import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { prisma } from "../lib/prisma.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import { generateAccessToken, generateRefreshToken } from "../utils/jwt.js";
import {
  validateClinicRegistration,
  validateSignup,
  validateLogin,
  validateClinicProfileUpdate
} from "../middleware/validators.js";
import { authLimiter } from "../middleware/rateLimit.js";
import {
  createEmailVerification,
  getVerificationErrorMessage,
  sendVerificationEmail,
  generateOtp,
  sendDeactivationOtpEmail,
  sendPasswordResetEmail,
} from "../services/emailVerification.js";
import {
  hasActivePaidSubscription,
  hasActiveProAccess,
  hasEnterpriseAccess,
  isSubscriptionExpired,
  isTrialingClinic,
  getUpgradeRequiredMessage,
  getAdminSubscriptionExpiredMessage,
  getStaffSubscriptionExpiredMessage,
} from "../utils/subscriptionAccess.js";
import crypto from "crypto";
import {
  getAllActiveClinicBranches,
  getAllowedActiveBranches,
  normalizeAssignedBranchIds,
  resolveActiveBranch,
  serializeBranch,
  STAFF_BRANCH_ACCESS_MESSAGE,
} from "../utils/branchAccess.js";

const router = express.Router();
const STAFF_ROLES = ["admin", "branch_manager", "doctor", "nurse"];
const STAFF_MANAGER_ROLES = ["admin", "branch_manager"];
const BRANCH_MANAGER_MANAGEABLE_ROLES = ["doctor", "nurse"];
const isProduction = process.env.NODE_ENV === "production";
const configuredCookieSameSite = String(process.env.COOKIE_SAME_SITE || "")
  .trim()
  .toLowerCase();
const cookieSameSite =
  configuredCookieSameSite || (isProduction ? "none" : "lax");
const cookieDomain = String(process.env.COOKIE_DOMAIN || "").trim() || undefined;
const buildCookieOptions = (maxAge) => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: cookieSameSite,
  maxAge,
  ...(cookieDomain ? { domain: cookieDomain } : {}),
});
const clearCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: cookieSameSite,
  ...(cookieDomain ? { domain: cookieDomain } : {}),
};
const DEFAULT_PROCEDURE_PRESETS = [
  { description: "Consultation", category: "service", unitPrice: 5000 },
  { description: "Scaling and Polishing", category: "procedure", unitPrice: 15000 },
  { description: "Tooth Extraction", category: "procedure", unitPrice: 12000 },
  { description: "Dental Filling", category: "procedure", unitPrice: 10000 },
  { description: "Root Canal Treatment", category: "procedure", unitPrice: 45000 },
  { description: "Dental X-Ray", category: "lab", unitPrice: 8000 },
  { description: "Medication Dispensing", category: "medication", unitPrice: 3500 },
];
const normalizeProcedurePresetPrices = (value) => {
  const incoming =
    Array.isArray(value) && value.length > 0 ? value : DEFAULT_PROCEDURE_PRESETS;

  return incoming.map((preset, index) => {
    const fallback = DEFAULT_PROCEDURE_PRESETS[index] || DEFAULT_PROCEDURE_PRESETS[0];
    const unitPrice = Number(preset?.unitPrice);

    return {
      description: String(preset?.description || fallback.description || "").trim(),
      category: String(preset?.category || fallback.category || "service").trim() || "service",
      unitPrice: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : fallback.unitPrice,
    };
  });
};

const slugifyBranchPart = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const buildBranchSlug = ({ name, city, area }) =>
  [city, area, name].map(slugifyBranchPart).filter(Boolean).join("-");

const resolveSerializedBranchScope = async ({
  clinicId,
  role,
  assignedBranchIds = [],
  requestedBranchId = "",
}) => {
  const branches = await getAllowedActiveBranches({
    clinicId,
    role,
    assignedBranchIds,
  });

  const serializedBranches = branches.map(serializeBranch);
  const { activeBranch } = resolveActiveBranch(serializedBranches, requestedBranchId);

  return {
    branchId: activeBranch?.id || null,
    branch: activeBranch,
    availableBranches: serializedBranches,
  };
};



const serializeClinic = (clinic) =>
  clinic
    ? {
        id: clinic.id,
        name: clinic.name,
        email: clinic.email,
        phone: clinic.phone,
        country: clinic.country || "",
        city: clinic.city,
        address: clinic.address,
        contactPerson: clinic.contactPerson,
        procedurePresetPrices: normalizeProcedurePresetPrices(clinic.procedurePresetPrices),
        isActive: Boolean(clinic.isActive),
        plan: clinic.plan || "PRO",
        logoUrl: clinic.logoUrl || null,
        brandColor: clinic.brandColor || null,
        intakeEnabled: Boolean(clinic.intakeEnabled),
        intakePublicToken: clinic.intakePublicToken || null,
        reminderOffsets: Array.isArray(clinic.reminderOffsets) ? clinic.reminderOffsets : [1440, 120],
        subscriptionEnds: clinic.subscriptionEnds || null,
        paystackCustomerCode: clinic.paystackCustomerCode || null,
        paystackPlanCode: clinic.paystackPlanCode || null,
        paystackSubscriptionCode: clinic.paystackSubscriptionCode || null,
        paystackSubscriptionStatus: clinic.paystackSubscriptionStatus || null,
        paystackLastReference: clinic.paystackLastReference || null,
        hasActivePaidSubscription: hasActivePaidSubscription(clinic),
        hasActiveProAccess: hasActiveProAccess(clinic),
        hasEnterpriseAccess: hasEnterpriseAccess(clinic),
        isTrialing: isTrialingClinic(clinic),
        branchCount: Array.isArray(clinic.branches) ? clinic.branches.length : clinic._count?.branches || 0,
        createdAt: clinic.createdAt,
      }
    : null;

const serializeUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  customRoleTitle: user.customRoleTitle || null,
  clinicId: user.clinicId,
  assignedBranchIds: normalizeAssignedBranchIds(user.assignedBranchIds),
  branchId: user.branchId || null,
  branch: user.branch || null,
  branches: Array.isArray(user.availableBranches) ? user.availableBranches : [],
  clinic: serializeClinic(user.clinic),
  isActive: Boolean(user.isActive),
  emailVerified: Boolean(user.emailVerified),
  createdAt: user.createdAt,
});

const getUserById = (userId) =>
  prisma.user.findUnique({
    where: { id: userId },
    include: { clinic: true },
  });

const getUserByEmail = (email) =>
  prisma.user.findUnique({
    where: { email },
    include: { clinic: true },
  });

const resolveValidAssignedBranchIds = async ({
  clinicId,
  role,
  assignedBranchIds,
}) => {
  if (role === "admin") {
    return {
      error: null,
      branchIds: [],
    };
  }

  const normalizedAssignedBranchIds = normalizeAssignedBranchIds(assignedBranchIds);

  if (normalizedAssignedBranchIds.length === 0) {
    return {
      error: {
        status: 400,
        message: "Assign at least one branch to each non-admin staff account.",
      },
      branchIds: [],
    };
  }

  const activeBranches = await getAllActiveClinicBranches(clinicId);
  const activeBranchIds = new Set(activeBranches.map((branch) => branch.id));
  const invalidBranchId = normalizedAssignedBranchIds.find(
    (branchId) => !activeBranchIds.has(branchId),
  );

  if (invalidBranchId) {
    return {
      error: {
        status: 400,
        message: "Assigned branches must belong to this clinic and remain active.",
      },
      branchIds: [],
    };
  }

  return {
    error: null,
    branchIds: normalizedAssignedBranchIds,
  };
};

const canBranchManagerAssignRole = (role) =>
  BRANCH_MANAGER_MANAGEABLE_ROLES.includes(role);

const doAssignedBranchesFitWithinActorScope = (actorAssignedBranchIds, targetAssignedBranchIds) => {
  const actorBranchSet = new Set(normalizeAssignedBranchIds(actorAssignedBranchIds));
  const targetBranchIds = normalizeAssignedBranchIds(targetAssignedBranchIds);

  return targetBranchIds.length > 0 && targetBranchIds.every((branchId) => actorBranchSet.has(branchId));
};

const canActorManageUser = (actor, targetUser) => {
  if (actor.role === "admin") {
    return true;
  }

  if (actor.role !== "branch_manager") {
    return false;
  }

  if (!canBranchManagerAssignRole(targetUser.role)) {
    return false;
  }

  return doAssignedBranchesFitWithinActorScope(
    actor.assignedBranchIds,
    targetUser.assignedBranchIds,
  );
};

const filterManageableStaffForActor = (actor, staff) => {
  if (actor.role === "admin") {
    return staff;
  }

  if (actor.role !== "branch_manager") {
    return [];
  }

  return staff.filter((member) => canActorManageUser(actor, member));
};

const refreshVerificationForUser = async (user) => {
  const verification = createEmailVerification();

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerificationToken: verification.token,
      emailVerificationExpiresAt: verification.expiresAt,
    },
    include: { clinic: true },
  });

  await sendVerificationEmail({
    email: updatedUser.email,
    name: updatedUser.name,
    token: verification.token,
  });

  return updatedUser;
};

const createIntakePublicToken = () =>
  crypto.randomBytes(24).toString("hex");

const getCurrentActiveBranch = async (req) => {
  const branchId = String(req.user?.branchId || "").trim();

  if (!branchId) {
    return null;
  }

  return prisma.branch.findFirst({
    where: {
      id: branchId,
      clinicId: req.user.clinicId,
      isActive: true,
    },
  });
};

const ensureAnotherActiveAdminExists = async (userId, clinicId) => {
  const targetUser = await getUserById(userId);

  if (!targetUser || targetUser.clinicId !== clinicId) {
    return false;
  }

  if (targetUser.role !== "admin" || !targetUser.isActive) {
    return true;
  }

  const activeAdminCount = await prisma.user.count({
    where: {
      clinicId,
      role: "admin",
      isActive: true,
    },
  });

  return activeAdminCount > 1;
};

router.get("/clinic-profile", protect, async (req, res) => {
  try {
    const [clinic, currentBranch] = await Promise.all([
      prisma.clinic.findUnique({
        where: { id: req.user.clinicId },
        include: {
          _count: {
            select: { branches: true },
          },
        },
      }),
      getCurrentActiveBranch(req),
    ]);

    if (!clinic) {
      return res.status(404).json({ message: "Clinic profile not found" });
    }

    res.json({
      clinic: {
        ...serializeClinic(clinic),
        intakeEnabled: Boolean(currentBranch?.intakeEnabled),
        intakePublicToken: currentBranch?.intakePublicToken || null,
      },
      activeBranch: currentBranch ? serializeBranch(currentBranch) : req.user.branch || null,
      branches: Array.isArray(req.user.availableBranches) ? req.user.availableBranches : [],
    });
  } catch (error) {
    console.error("Get clinic profile error:", error);
    res.status(500).json({ message: "Failed to fetch clinic profile" });
  }
});

router.put("/clinic-profile", protect, authorizeRoles("admin"), validateClinicProfileUpdate, async (req, res) => {
  try {
    const clinicName = req.body?.clinicName?.trim();
    const clinicEmail = req.body?.clinicEmail?.trim().toLowerCase();
    const clinicPhone = req.body?.clinicPhone?.trim() || "";
    const clinicCountry = req.body?.clinicCountry?.trim() || "";
    const clinicCity = req.body?.clinicCity?.trim() || "";
    const clinicAddress = req.body?.clinicAddress?.trim() || "";
    const contactPerson = req.body?.contactPerson?.trim() || "";
    const logoUrl = req.body?.logoUrl?.trim() || null;
    const brandColor = req.body?.brandColor?.trim() || null;
    const reminderOffsets = Array.isArray(req.body?.reminderOffsets) 
      ? Array.from(new Set(req.body.reminderOffsets.map(Number).filter(n => Number.isFinite(n) && n > 0))).sort((a, b) => b - a)
      : [1440, 120];
    const procedurePresetPrices = normalizeProcedurePresetPrices(
      req.body?.procedurePresetPrices,
    );

    if (!clinicName || !clinicEmail) {
      return res.status(400).json({
        message: "Clinic name and clinic email are required",
      });
    }

    const duplicateClinic = await prisma.clinic.findFirst({
      where: {
        email: clinicEmail,
        id: { not: req.user.clinicId },
      },
      select: { id: true },
    });

    if (duplicateClinic) {
      return res.status(400).json({
        message: "Another clinic is already using this email address",
      });
    }

    const clinic = await prisma.clinic.update({
      where: { id: req.user.clinicId },
      data: {
        name: clinicName,
        email: clinicEmail,
        phone: clinicPhone,
        country: clinicCountry,
        city: clinicCity,
        address: clinicAddress,
        contactPerson,
        logoUrl,
        brandColor,
        reminderOffsets,
        procedurePresetPrices,
      },
    });

    res.json({
      message: "Clinic profile updated successfully",
      clinic: serializeClinic(clinic),
    });
  } catch (error) {
    console.error("Update clinic profile error:", error);
    res.status(500).json({ message: "Failed to update clinic profile" });
  }
});

router.put("/clinic-profile/intake-link", protect, authorizeRoles("admin", "branch_manager", "doctor", "nurse"), async (req, res) => {
  try {
    const requestedEnabled = req.body?.intakeEnabled;

    if (typeof requestedEnabled !== "boolean") {
      return res.status(400).json({ message: "intakeEnabled must be provided as true or false" });
    }

    const existingClinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
    });

    if (!existingClinic) {
      return res.status(404).json({ message: "Clinic profile not found" });
    }

    if (!hasActiveProAccess(existingClinic)) {
      return res.status(403).json({
        message: getUpgradeRequiredMessage(),
        errorCode: "UPGRADE_REQUIRED",
      });
    }

    const currentBranch = await getCurrentActiveBranch(req);

    if (!currentBranch) {
      return res.status(404).json({ message: "No active branch is available for this staff account." });
    }

    const intakePublicToken =
      requestedEnabled && !currentBranch.intakePublicToken
        ? createIntakePublicToken()
        : currentBranch.intakePublicToken;

    const branch = await prisma.branch.update({
      where: { id: currentBranch.id },
      data: {
        intakeEnabled: requestedEnabled,
        intakePublicToken,
      },
    });

    res.json({
      message: requestedEnabled
        ? "Patient intake link enabled successfully for this branch"
        : "Patient intake link disabled successfully for this branch",
      clinic: {
        intakeEnabled: branch.intakeEnabled,
        intakePublicToken: branch.intakePublicToken,
      },
      branch: serializeBranch(branch),
    });
  } catch (error) {
    console.error("Update intake link settings error:", error);
    res.status(500).json({ message: "Failed to update patient intake link settings" });
  }
});

router.post("/clinic-profile/intake-link/regenerate", protect, authorizeRoles("admin", "branch_manager"), async (req, res) => {
  try {
    const existingClinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
    });

    if (!existingClinic) {
      return res.status(404).json({ message: "Clinic profile not found" });
    }

    if (!hasActiveProAccess(existingClinic)) {
      return res.status(403).json({
        message: getUpgradeRequiredMessage(),
        errorCode: "UPGRADE_REQUIRED",
      });
    }

    const currentBranch = await getCurrentActiveBranch(req);

    if (!currentBranch) {
      return res.status(404).json({ message: "No active branch is available for this staff account." });
    }

    const branch = await prisma.branch.update({
      where: { id: currentBranch.id },
      data: {
        intakeEnabled: true,
        intakePublicToken: createIntakePublicToken(),
      },
    });

    res.json({
      message: "Patient intake link regenerated successfully for this branch",
      clinic: {
        intakeEnabled: branch.intakeEnabled,
        intakePublicToken: branch.intakePublicToken,
      },
      branch: serializeBranch(branch),
    });
  } catch (error) {
    console.error("Regenerate intake link error:", error);
    res.status(500).json({ message: "Failed to regenerate patient intake link" });
  }
});

router.post("/clinic-profile/deactivate/initiate", protect, authorizeRoles("admin"), async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ message: "Password is required to initiate deactivation" });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { clinic: true },
    });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Incorrect password" });
    }

    const activeAdminCount = await prisma.user.count({
      where: {
        clinicId: req.user.clinicId,
        role: "admin",
        isActive: true,
      },
    });

    if (activeAdminCount === 0) {
      return res.status(400).json({
        message: "No active admin account found for this clinic",
      });
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        emailVerificationToken: otp,
        emailVerificationExpiresAt: expiresAt,
      },
    });

    try {
      await sendDeactivationOtpEmail({
        email: user.email,
        name: user.name,
        otp,
      });
      res.json({ message: "Verification code sent to your email" });
    } catch (emailError) {
      console.error("Deactivation OTP email error:", emailError);
      if (process.env.NODE_ENV !== "production") {
        console.log(`[LOCAL DEV] OTP for deactivation is: ${otp}`);
        return res.json({ message: "Verification code sent to your email" });
      }
      return res.status(500).json({ message: "Failed to send verification email. Please try again later." });
    }
  } catch (error) {
    console.error("Initiate deactivate clinic error:", error);
    res.status(500).json({ message: "Failed to initiate clinic deactivation" });
  }
});

router.post("/clinic-profile/deactivate/verify", protect, authorizeRoles("admin"), async (req, res) => {
  try {
    const { otp } = req.body;
    if (!otp) {
      return res.status(400).json({ message: "Verification code is required" });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });

    if (
      !user.emailVerificationToken || 
      user.emailVerificationToken !== otp || 
      !user.emailVerificationExpiresAt || 
      user.emailVerificationExpiresAt.getTime() < Date.now()
    ) {
      return res.status(400).json({ message: "Invalid or expired verification code" });
    }

    // Clear the token
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        emailVerificationToken: null,
        emailVerificationExpiresAt: null,
      },
    });

    const clinic = await prisma.clinic.update({
      where: { id: req.user.clinicId },
      data: { isActive: false },
    });

    await prisma.user.updateMany({
      where: { clinicId: req.user.clinicId },
      data: { refreshToken: null },
    });

    res.json({
      message: "Clinic deactivated successfully. All staff logins are now blocked until support reactivates the clinic.",
      clinic: serializeClinic(clinic),
    });
  } catch (error) {
    console.error("Verify deactivate clinic error:", error);
    res.status(500).json({ message: "Failed to deactivate clinic" });
  }
});

router.post("/register-clinic", authLimiter, validateClinicRegistration, async (req, res) => {
  try {
    const {
      clinicName,
      clinicEmail,
      clinicPhone,
      clinicCountry,
      clinicCity,
      clinicAddress,
      adminName,
      adminEmail,
      password,
    } = req.body;

    if (
      !clinicName?.trim() ||
      !clinicEmail?.trim() ||
      !adminName?.trim() ||
      !adminEmail?.trim() ||
      !password?.trim()
    ) {
      return res.status(400).json({
        code: "MISSING_REQUIRED_FIELDS",
        message:
          "Clinic name, clinic email, admin name, admin email, and password are required",
      });
    }

    const normalizedClinicEmail = clinicEmail.toLowerCase().trim();
    const normalizedAdminEmail = adminEmail.toLowerCase().trim();

    const [existingClinic, existingAdmin] = await Promise.all([
      prisma.clinic.findUnique({ where: { email: normalizedClinicEmail } }),
      prisma.user.findUnique({ where: { email: normalizedAdminEmail } }),
    ]);

    if (existingClinic) {
      return res.status(400).json({
        code: "CLINIC_EMAIL_EXISTS",
        message: "A clinic with this email has already been registered",
      });
    }

    if (existingAdmin) {
      return res.status(400).json({
        code: "ADMIN_EMAIL_EXISTS",
        message: "A user with this admin email already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password.trim(), 10);
    const verification = createEmailVerification();

    const { clinic, adminUser } = await prisma.$transaction(async (tx) => {
      const createdClinic = await tx.clinic.create({
        data: {
          name: clinicName.trim(),
          email: normalizedClinicEmail,
          phone: clinicPhone?.trim() || "",
          country: clinicCountry?.trim() || "",
          city: clinicCity?.trim() || "",
          address: clinicAddress?.trim() || "",
          contactPerson: adminName.trim(),
          plan: "PRO",
          subscriptionEnds: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
        include: {
          branches: true,
        },
      });

      await tx.branch.create({
        data: {
          clinicId: createdClinic.id,
          name: clinicName.trim(),
          slug:
            buildBranchSlug({
              name: clinicName.trim(),
              city: clinicCity?.trim() || "",
              area: "",
            }) || `branch-${Date.now()}`,
          country: clinicCountry?.trim() || "",
          city: clinicCity?.trim() || "",
          area: "",
          address: clinicAddress?.trim() || "",
          phone: clinicPhone?.trim() || "",
          isPrimary: true,
        },
      });

      const createdAdmin = await tx.user.create({
        data: {
          name: adminName.trim(),
          email: normalizedAdminEmail,
          password: hashedPassword,
          role: "admin",
          clinicId: createdClinic.id,
          emailVerified: false,
          emailVerificationToken: verification.token,
          emailVerificationExpiresAt: verification.expiresAt,
        },
        include: { clinic: true },
      });

      return { clinic: createdClinic, adminUser: createdAdmin };
    });

    let emailWarning = "";

    try {
      await sendVerificationEmail({
        email: adminUser.email,
        name: adminUser.name,
        token: verification.token,
      });
    } catch (emailError) {
      console.error("Clinic registration verification email error:", emailError);
      emailWarning =
        " Clinic account was created, but the verification email could not be sent right now. Please use the resend verification option from the login page after email delivery is configured.";
    }

    res.status(201).json({
      message: `Clinic registered successfully.${emailWarning || " A welcome email has been sent to confirm the admin account."}`,
      clinic: serializeClinic(clinic),
      user: serializeUser(adminUser),
      emailSent: !emailWarning,
    });
  } catch (error) {
    console.error("Clinic registration error:", error);
    res.status(500).json({ message: "Failed to register clinic" });
  }
});

router.post("/signup", protect, authorizeRoles(...STAFF_MANAGER_ROLES), validateSignup, async (req, res) => {
  try {
    const { name, email, password, role, customRoleTitle, assignedBranchIds } = req.body;
    const requestedRole = role || "nurse";

    if (!name?.trim() || !email?.trim() || !password) {
      return res
        .status(400)
        .json({ message: "Name, email and password are required" });
    }

    if (!STAFF_ROLES.includes(requestedRole) || requestedRole === "admin") {
      return res.status(400).json({ message: "Invalid staff role" });
    }

    if (
      req.user.role === "branch_manager" &&
      !canBranchManagerAssignRole(requestedRole)
    ) {
      return res.status(403).json({
        message: "Branch managers can only create doctor or nurse accounts.",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await getUserByEmail(normalizedEmail);

    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId }
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    if (!hasActiveProAccess(clinic)) {
      return res.status(403).json({
        message: getUpgradeRequiredMessage(),
        errorCode: "UPGRADE_REQUIRED",
      });
    }

    const branchAssignment = await resolveValidAssignedBranchIds({
      clinicId: req.user.clinicId,
      role: requestedRole,
      assignedBranchIds,
    });

    if (branchAssignment.error) {
      return res.status(branchAssignment.error.status).json({
        message: branchAssignment.error.message,
      });
    }

    if (
      req.user.role === "branch_manager" &&
      !doAssignedBranchesFitWithinActorScope(
        req.user.assignedBranchIds,
        branchAssignment.branchIds,
      )
    ) {
      return res.status(403).json({
        message: "You can only assign staff to branches you manage.",
      });
    }

    const hashedPassword = await bcrypt.hash(password.trim(), 10);
    const verification = createEmailVerification();
    const newUser = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        role: requestedRole,
        customRoleTitle: customRoleTitle?.trim() || null,
        clinicId: req.user.clinicId,
        assignedBranchIds: branchAssignment.branchIds,
        emailVerified: false,
        emailVerificationToken: verification.token,
        emailVerificationExpiresAt: verification.expiresAt,
      },
      include: { clinic: true },
    });

    try {
      await sendVerificationEmail({
        email: newUser.email,
        name: newUser.name,
        token: verification.token,
      });
    } catch (emailError) {
      console.error("Staff verification email error:", emailError);
      await prisma.user.delete({
        where: { id: newUser.id },
      });
      return res.status(500).json({
        message: getVerificationErrorMessage(emailError),
      });
    }

    res.status(201).json({
      user: serializeUser(newUser),
      message:
        "Staff account created successfully. A welcome email was sent so the user can confirm their address and activate the account.",
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/staff", protect, authorizeRoles(...STAFF_MANAGER_ROLES), async (req, res) => {
  try {
    if (isSubscriptionExpired(req.user.clinic)) {
      return res.status(403).json({
        message: getAdminSubscriptionExpiredMessage(),
        errorCode: "SUBSCRIPTION_EXPIRED",
      });
    }

    const staff = await prisma.user.findMany({
      where: { clinicId: req.user.clinicId },
      include: { clinic: true },
      orderBy: [{ createdAt: "desc" }, { name: "asc" }],
    });

    res.json(filterManageableStaffForActor(req.user, staff).map(serializeUser));
  } catch (error) {
    console.error("Get staff error:", error);
    res.status(500).json({ message: "Failed to fetch staff accounts" });
  }
});

router.patch("/staff/:id/branches", protect, authorizeRoles(...STAFF_MANAGER_ROLES), async (req, res) => {
  try {
    if (isSubscriptionExpired(req.user.clinic)) {
      return res.status(403).json({
        message: getAdminSubscriptionExpiredMessage(),
        errorCode: "SUBSCRIPTION_EXPIRED",
      });
    }

    const existingUser = await getUserById(req.params.id);

    if (!existingUser || existingUser.clinicId !== req.user.clinicId) {
      return res.status(404).json({ message: "Staff account not found" });
    }

    if (existingUser.role === "admin") {
      return res.status(400).json({
        message: "Admin accounts always have access to all clinic branches.",
      });
    }

    if (!canActorManageUser(req.user, existingUser)) {
      return res.status(403).json({
        message: "You can only update staff in branches you manage.",
      });
    }

    const branchAssignment = await resolveValidAssignedBranchIds({
      clinicId: req.user.clinicId,
      role: existingUser.role,
      assignedBranchIds: req.body?.assignedBranchIds,
    });

    if (branchAssignment.error) {
      return res.status(branchAssignment.error.status).json({
        message: branchAssignment.error.message,
      });
    }

    if (
      req.user.role === "branch_manager" &&
      !doAssignedBranchesFitWithinActorScope(
        req.user.assignedBranchIds,
        branchAssignment.branchIds,
      )
    ) {
      return res.status(403).json({
        message: "You can only assign staff to branches you manage.",
      });
    }

    const updatedUser = await prisma.user.update({
      where: { id: existingUser.id },
      data: {
        assignedBranchIds: branchAssignment.branchIds,
      },
      include: { clinic: true },
    });

    res.json({
      message: "Staff branch assignments updated successfully.",
      user: serializeUser(updatedUser),
    });
  } catch (error) {
    console.error("Update staff branches error:", error);
    res.status(500).json({ message: "Failed to update staff branch assignments" });
  }
});

router.patch("/staff/:id/status", protect, authorizeRoles(...STAFF_MANAGER_ROLES), async (req, res) => {
  try {
    if (isSubscriptionExpired(req.user.clinic)) {
      return res.status(403).json({
        message: getAdminSubscriptionExpiredMessage(),
        errorCode: "SUBSCRIPTION_EXPIRED",
      });
    }

    const isActive = Boolean(req.body?.isActive);
    const existingUser = await getUserById(req.params.id);

    if (!existingUser || existingUser.clinicId !== req.user.clinicId) {
      return res.status(404).json({ message: "Staff account not found" });
    }

    if (!canActorManageUser(req.user, existingUser)) {
      return res.status(403).json({
        message: "You can only update staff in branches you manage.",
      });
    }

    if (existingUser.id === req.user.id && !isActive) {
      return res.status(400).json({ message: "You cannot deactivate your own account" });
    }

    if (!isActive) {
      const canDeactivate = await ensureAnotherActiveAdminExists(
        existingUser.id,
        req.user.clinicId,
      );
      if (!canDeactivate) {
        return res.status(400).json({
          message: "You cannot deactivate the last active admin account",
        });
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: existingUser.id },
      data: {
        isActive,
        refreshToken: isActive ? existingUser.refreshToken : null,
      },
      include: { clinic: true },
    });

    res.json({
      message: isActive ? "Staff account activated" : "Staff account deactivated",
      user: serializeUser(updatedUser),
    });
  } catch (error) {
    console.error("Update staff status error:", error);
    res.status(500).json({ message: "Failed to update staff status" });
  }
});

router.delete("/staff/:id", protect, authorizeRoles(...STAFF_MANAGER_ROLES), async (req, res) => {
  try {
    if (isSubscriptionExpired(req.user.clinic)) {
      return res.status(403).json({
        message: getAdminSubscriptionExpiredMessage(),
        errorCode: "SUBSCRIPTION_EXPIRED",
      });
    }

    const existingUser = await getUserById(req.params.id);

    if (!existingUser || existingUser.clinicId !== req.user.clinicId) {
      return res.status(404).json({ message: "Staff account not found" });
    }

    if (!canActorManageUser(req.user, existingUser)) {
      return res.status(403).json({
        message: "You can only delete staff in branches you manage.",
      });
    }

    if (existingUser.id === req.user.id) {
      return res.status(400).json({ message: "You cannot delete your own account" });
    }

    const canDelete = await ensureAnotherActiveAdminExists(
      existingUser.id,
      req.user.clinicId,
    );
    if (!canDelete) {
      return res.status(400).json({
        message: "You cannot delete the last active admin account",
      });
    }

    await prisma.user.delete({
      where: { id: existingUser.id },
    });

    res.json({ message: "Staff account deleted successfully" });
  } catch (error) {
    console.error("Delete staff error:", error);
    res.status(500).json({ message: "Failed to delete staff account" });
  }
});

router.post("/login", authLimiter, validateLogin, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const user = await getUserByEmail(email.toLowerCase().trim());

    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.isActive) {
      return res.status(403).json({ message: "Your staff account has been deactivated" });
    }
    if (!user.emailVerified) {
      return res.status(403).json({
        message:
          "Please confirm your email address to activate your account before signing in.",
      });
    }
    if (!user.clinic?.isActive) {
      return res.status(403).json({
        message: "Your clinic account has been deactivated. Contact support for reactivation.",
      });
    }

    if (isSubscriptionExpired(user.clinic) && user.role !== "admin") {
      return res.status(403).json({
        message: getStaffSubscriptionExpiredMessage(),
        errorCode: "SUBSCRIPTION_EXPIRED",
      });
    }

    if (!hasActiveProAccess(user.clinic) && user.role === "admin") {
      // Allow admins to sign in so they can renew from the billing flow.
    } else if (!hasActiveProAccess(user.clinic)) {
      return res.status(403).json({
        message: getUpgradeRequiredMessage(),
        errorCode: "UPGRADE_REQUIRED",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid password" });

    const refreshToken = generateRefreshToken(user);
    const sessionId = refreshToken.substring(refreshToken.length - 15);
    const accessToken = generateAccessToken(user, sessionId);

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken },
    });

    res.cookie("accessToken", accessToken, buildCookieOptions(15 * 60 * 1000));

    res.cookie(
      "refreshToken",
      refreshToken,
      buildCookieOptions(7 * 24 * 60 * 60 * 1000),
    );

    const branchScope = await resolveSerializedBranchScope({
      clinicId: user.clinicId,
      role: user.role,
      assignedBranchIds: user.assignedBranchIds,
      requestedBranchId: String(req.headers?.["x-branch-id"] || req.query?.branchId || "").trim(),
    });

    if (user.role !== "admin" && branchScope.availableBranches.length === 0) {
      return res.status(403).json({ message: STAFF_BRANCH_ACCESS_MESSAGE });
    }

    res.json({
      accessToken,
      refreshToken,
      user: serializeUser({
        ...user,
        branchId: branchScope.branchId,
        branch: branchScope.branch,
        availableBranches: branchScope.availableBranches,
      }),
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/verify-email", async (req, res) => {
  try {
    const token = String(req.query?.token || "").trim();

    if (!token) {
      return res.status(400).json({ message: "Verification token is required" });
    }

    const user = await prisma.user.findFirst({
      where: { emailVerificationToken: token },
      include: { clinic: true },
    });

    if (!user) {
      return res.status(400).json({
        message:
          "This verification link is invalid, expired, or has already been used. Please sign in or request a new verification email.",
      });
    }

    if (user.emailVerified) {
      return res.json({
        message: "Email address already confirmed. You can sign in now.",
        user: serializeUser(user),
      });
    }

    if (
      user.emailVerificationExpiresAt &&
      user.emailVerificationExpiresAt.getTime() < Date.now()
    ) {
      return res.status(400).json({
        message:
          "This verification link has expired. Please go back and request a new verification email.",
      });
    }

    const verifiedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpiresAt: null,
      },
      include: { clinic: true },
    });

    res.json({
      message: "Email confirmed successfully. Your account is now active.",
      user: serializeUser(verifiedUser),
    });
  } catch (error) {
    console.error("Verify email error:", error);
    res.status(500).json({ message: "Failed to verify email" });
  }
});

router.post("/resend-verification", authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await getUserByEmail(email);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: "Your staff account has been deactivated" });
    }

    if (!user.clinic?.isActive) {
      return res.status(403).json({
        message: "Your clinic account has been deactivated. Contact support for reactivation.",
      });
    }

    if (user.emailVerified) {
      return res.status(400).json({
        message: "This email address is already confirmed. You can sign in now.",
      });
    }

    await refreshVerificationForUser(user);

    res.json({
      message:
        "A new verification email has been sent. Please check your inbox and spam folder.",
    });
  } catch (error) {
    console.error("Resend verification error:", error);
    res.status(500).json({
      message: getVerificationErrorMessage(error),
    });
  }
});

router.post("/refresh-token", async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!refreshToken) {
    return res.status(401).json({ message: "Refresh token required" });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await getUserById(decoded.id);

    if (!user || user.refreshToken !== refreshToken) {
      return res.status(403).json({ message: "Invalid refresh token" });
    }
    if (!user.isActive) {
      return res.status(403).json({ message: "Your staff account has been deactivated" });
    }
    if (!user.emailVerified) {
      return res.status(403).json({
        message:
          "Please confirm your email address to activate your account before signing in.",
      });
    }
    if (!user.clinic?.isActive) {
      return res.status(403).json({
        message: "Your clinic account has been deactivated. Contact support for reactivation.",
      });
    }
    if (isSubscriptionExpired(user.clinic) && user.role !== "admin") {
      return res.status(403).json({
        message: getStaffSubscriptionExpiredMessage(),
        errorCode: "SUBSCRIPTION_EXPIRED",
      });
    }

    if (!hasActiveProAccess(user.clinic) && user.role === "admin") {
      const sessionId = user.refreshToken.substring(user.refreshToken.length - 15);
      const newAccessToken = generateAccessToken(user, sessionId);
      res.cookie(
        "accessToken",
        newAccessToken,
        buildCookieOptions(15 * 60 * 1000),
      );
      return res.json({ success: true, accessToken: newAccessToken });
    }

    if (!hasActiveProAccess(user.clinic)) {
      return res.status(403).json({
        message: getUpgradeRequiredMessage(),
        errorCode: "UPGRADE_REQUIRED",
      });
    }

    const sessionId = user.refreshToken.substring(user.refreshToken.length - 15);
    const newAccessToken = generateAccessToken(user, sessionId);
    res.cookie(
      "accessToken",
      newAccessToken,
      buildCookieOptions(15 * 60 * 1000),
    );
    res.json({ success: true, accessToken: newAccessToken });
  } catch (error) {
    console.error("Refresh token error:", error);
    res.status(403).json({ message: "Refresh token expired or invalid" });
  }
});

router.post("/logout", async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  
  res.clearCookie("accessToken", clearCookieOptions);
  res.clearCookie("refreshToken", clearCookieOptions);

  if (!refreshToken) return res.sendStatus(204);

  try {
    await prisma.user.updateMany({
      where: { refreshToken },
      data: { refreshToken: null },
    });

    res.sendStatus(204);
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await getUserByEmail(email);

    // We still return success even if user not found to prevent email enumeration attacks
    if (!user || !user.isActive) {
      return res.json({ message: "If an account exists, a password reset link has been sent to the email." });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetPasswordExpiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: resetToken,
        resetPasswordExpiresAt,
      },
    });

    try {
      await sendPasswordResetEmail({
        email: user.email,
        name: user.name,
        token: resetToken,
      });
    } catch (emailError) {
      console.error("Forgot password email error:", emailError);
      // We don't rollback the token, they can try again
      return res.status(500).json({ message: "Failed to send reset email. Please try again later." });
    }

    res.json({ message: "If an account exists, a password reset link has been sent to the email." });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ message: "Token and new password are required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters long" });
    }

    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: token,
      },
    });

    if (!user || !user.resetPasswordExpiresAt || user.resetPasswordExpiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: "This password reset link is invalid or has expired." });
    }

    const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetPasswordToken: null,
        resetPasswordExpiresAt: null,
        // Optional: clear refresh tokens to force re-login on all devices
        refreshToken: null,
      },
    });

    res.json({ message: "Password reset successfully. You can now sign in with your new password." });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
