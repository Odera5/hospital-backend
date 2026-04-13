import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { prisma } from "../lib/prisma.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import { generateAccessToken, generateRefreshToken } from "../utils/jwt.js";
import {
  createEmailVerification,
  getVerificationErrorMessage,
  sendVerificationEmail,
} from "../services/emailVerification.js";

const router = express.Router();
const STAFF_ROLES = ["admin", "doctor", "nurse"];
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

const serializeClinic = (clinic) =>
  clinic
    ? {
        id: clinic.id,
        name: clinic.name,
        email: clinic.email,
        phone: clinic.phone,
        city: clinic.city,
        address: clinic.address,
        contactPerson: clinic.contactPerson,
        procedurePresetPrices: normalizeProcedurePresetPrices(clinic.procedurePresetPrices),
        isActive: Boolean(clinic.isActive),
        plan: clinic.plan || "FREE",
        subscriptionEnds: clinic.subscriptionEnds || null,
        createdAt: clinic.createdAt,
      }
    : null;

const serializeUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  clinicId: user.clinicId,
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
    const clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic profile not found" });
    }

    res.json({ clinic: serializeClinic(clinic) });
  } catch (error) {
    console.error("Get clinic profile error:", error);
    res.status(500).json({ message: "Failed to fetch clinic profile" });
  }
});

router.put("/clinic-profile", protect, authorizeRoles("admin"), async (req, res) => {
  try {
    const clinicName = req.body?.clinicName?.trim();
    const clinicEmail = req.body?.clinicEmail?.trim().toLowerCase();
    const clinicPhone = req.body?.clinicPhone?.trim() || "";
    const clinicCity = req.body?.clinicCity?.trim() || "";
    const clinicAddress = req.body?.clinicAddress?.trim() || "";
    const contactPerson = req.body?.contactPerson?.trim() || "";
    const procedurePresetPrices = normalizeProcedurePresetPrices(
      req.body?.procedurePresetPrices,
    );

    if (!clinicName || !clinicEmail) {
      return res.status(400).json({
        message: "Clinic name and clinic email are required",
      });
    }

    const existingClinic = await prisma.clinic.findFirst({
      where: {
        email: clinicEmail,
        id: { not: req.user.clinicId },
      },
      select: { id: true },
    });

    if (existingClinic) {
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
        city: clinicCity,
        address: clinicAddress,
        contactPerson,
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

router.patch("/clinic-profile/deactivate", protect, authorizeRoles("admin"), async (req, res) => {
  try {
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

    const clinic = await prisma.clinic.update({
      where: { id: req.user.clinicId },
      data: { isActive: false },
    });

    await prisma.user.updateMany({
      where: { clinicId: req.user.clinicId },
      data: { refreshToken: null },
    });

    res.json({
      message:
        "Clinic deactivated successfully. All staff logins are now blocked until support reactivates the clinic.",
      clinic: serializeClinic(clinic),
    });
  } catch (error) {
    console.error("Deactivate clinic error:", error);
    res.status(500).json({ message: "Failed to deactivate clinic" });
  }
});

router.post("/register-clinic", async (req, res) => {
  try {
    const {
      clinicName,
      clinicEmail,
      clinicPhone,
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
          city: clinicCity?.trim() || "",
          address: clinicAddress?.trim() || "",
          contactPerson: adminName.trim(),
          plan: "PRO",
          subscriptionEnds: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
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

router.post("/signup", protect, authorizeRoles("admin"), async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name?.trim() || !email?.trim() || !password) {
      return res
        .status(400)
        .json({ message: "Name, email and password are required" });
    }

    if (!STAFF_ROLES.includes(role || "nurse")) {
      return res.status(400).json({ message: "Invalid staff role" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await getUserByEmail(normalizedEmail);

    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password.trim(), 10);
    const verification = createEmailVerification();
    const newUser = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        role: role || "nurse",
        clinicId: req.user.clinicId,
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

router.get("/staff", protect, authorizeRoles("admin"), async (req, res) => {
  try {
    const staff = await prisma.user.findMany({
      where: { clinicId: req.user.clinicId },
      include: { clinic: true },
      orderBy: [{ createdAt: "desc" }, { name: "asc" }],
    });

    res.json(staff.map(serializeUser));
  } catch (error) {
    console.error("Get staff error:", error);
    res.status(500).json({ message: "Failed to fetch staff accounts" });
  }
});

router.patch("/staff/:id/status", protect, authorizeRoles("admin"), async (req, res) => {
  try {
    const isActive = Boolean(req.body?.isActive);
    const existingUser = await getUserById(req.params.id);

    if (!existingUser || existingUser.clinicId !== req.user.clinicId) {
      return res.status(404).json({ message: "Staff account not found" });
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

router.delete("/staff/:id", protect, authorizeRoles("admin"), async (req, res) => {
  try {
    const existingUser = await getUserById(req.params.id);

    if (!existingUser || existingUser.clinicId !== req.user.clinicId) {
      return res.status(404).json({ message: "Staff account not found" });
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

router.post("/login", async (req, res) => {
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

    // Auto-Downgrade Check: If trial expired, drop to FREE
    if (user.clinic.plan === "PRO" && user.clinic.subscriptionEnds && new Date(user.clinic.subscriptionEnds) < new Date()) {
      await prisma.clinic.update({
        where: { id: user.clinic.id },
        data: { plan: "FREE" }
      });
      user.clinic.plan = "FREE";
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid password" });

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken },
    });

    res.json({
      accessToken,
      refreshToken,
      user: serializeUser(user),
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

router.post("/resend-verification", async (req, res) => {
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
  const { refreshToken } = req.body;
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
    if (!user.clinic?.isActive) {
      return res.status(403).json({
        message: "Your clinic account has been deactivated. Contact support for reactivation.",
      });
    }

    const newAccessToken = generateAccessToken(user);
    res.json({ accessToken: newAccessToken });
  } catch (error) {
    console.error("Refresh token error:", error);
    res.status(403).json({ message: "Refresh token expired or invalid" });
  }
});

router.post("/logout", async (req, res) => {
  const { refreshToken } = req.body;
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

export default router;
