import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { prisma } from "../lib/prisma.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import { generateAccessToken, generateRefreshToken } from "../utils/jwt.js";

const router = express.Router();
const STAFF_ROLES = ["admin", "doctor", "nurse"];

const serializeUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  isActive: Boolean(user.isActive),
  createdAt: user.createdAt,
});

const getUserById = async (userId) => {
  const users = await prisma.$queryRaw`
    SELECT id, name, email, password, role, "isActive", "refreshToken", "createdAt", "updatedAt"
    FROM "User"
    WHERE id = ${userId}
    LIMIT 1
  `;

  return users[0] ?? null;
};

const getUserByEmail = async (email) => {
  const users = await prisma.$queryRaw`
    SELECT id, name, email, password, role, "isActive", "refreshToken", "createdAt", "updatedAt"
    FROM "User"
    WHERE email = ${email}
    LIMIT 1
  `;

  return users[0] ?? null;
};

const getAllStaff = async () => {
  return prisma.$queryRaw`
    SELECT id, name, email, role, "isActive", "createdAt"
    FROM "User"
    ORDER BY "createdAt" DESC, name ASC
  `;
};

const ensureAnotherActiveAdminExists = async (userId) => {
  const adminCounts = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM "User"
    WHERE role = 'admin' AND "isActive" = true
  `;
  const activeAdminCount = adminCounts[0]?.count || 0;
  const targetUser = await getUserById(userId);

  if (
    targetUser?.role === "admin" &&
    targetUser.isActive &&
    activeAdminCount <= 1
  ) {
    return false;
  }

  return true;
};

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
    const newUser = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        role: role || "nurse",
      },
    });

    const accessToken = generateAccessToken(newUser);
    const refreshToken = generateRefreshToken(newUser);

    await prisma.user.update({
      where: { id: newUser.id },
      data: { refreshToken },
    });

    res.status(201).json({
      user: serializeUser(newUser),
      message: "Staff account created successfully",
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/staff", protect, authorizeRoles("admin"), async (req, res) => {
  try {
    const staff = await getAllStaff();

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

    if (!existingUser) {
      return res.status(404).json({ message: "Staff account not found" });
    }

    if (existingUser.id === req.user.id && !isActive) {
      return res.status(400).json({ message: "You cannot deactivate your own account" });
    }

    if (!isActive) {
      const canDeactivate = await ensureAnotherActiveAdminExists(existingUser.id);
      if (!canDeactivate) {
        return res.status(400).json({
          message: "You cannot deactivate the last active admin account",
        });
      }
    }

    await prisma.$executeRaw`
      UPDATE "User"
      SET "isActive" = ${isActive},
          "refreshToken" = ${isActive ? existingUser.refreshToken : null},
          "updatedAt" = NOW()
      WHERE id = ${existingUser.id}
    `;
    const updatedUser = await getUserById(existingUser.id);

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

    if (!existingUser) {
      return res.status(404).json({ message: "Staff account not found" });
    }

    if (existingUser.id === req.user.id) {
      return res.status(400).json({ message: "You cannot delete your own account" });
    }

    const canDelete = await ensureAnotherActiveAdminExists(existingUser.id);
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
