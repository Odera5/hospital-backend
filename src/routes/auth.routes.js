// src/routes/auth.routes.js
import express from "express";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import { generateAccessToken, generateRefreshToken } from "../utils/jwt.js"; // use your utility functions

dotenv.config();
const router = express.Router();

// =========================
// SIGNUP
// =========================
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ message: "Name, email and password are required" });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) return res.status(400).json({ message: "User already exists" });

    const newUser = new User({
      name: name.trim(),
      email: email.toLowerCase(),
      password: password.trim(),
      role: role || "nurse",
    });
    await newUser.save();

    const accessToken = generateAccessToken(newUser);
    const refreshToken = generateRefreshToken(newUser);

    newUser.refreshToken = refreshToken;
    await newUser.save();

    res.status(201).json({
      accessToken,
      refreshToken,
      user: { name: newUser.name, email: newUser.email, role: newUser.role },
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// =========================
// LOGIN
// =========================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password required" });

    const user = await User.findOne({ email: email.toLowerCase() }).select("+password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ message: "Invalid password" });

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    user.refreshToken = refreshToken;
    await user.save();

    res.json({
      accessToken,
      refreshToken,
      user: { name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// =========================
// REFRESH TOKEN
// =========================
router.post("/refresh-token", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ message: "Refresh token required" });

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id);

    if (!user || user.refreshToken !== refreshToken) {
      return res.status(403).json({ message: "Invalid refresh token" });
    }

    const newAccessToken = generateAccessToken(user);
    res.json({ accessToken: newAccessToken });
  } catch (err) {
    console.error("Refresh token error:", err);
    res.status(403).json({ message: "Refresh token expired or invalid" });
  }
});

// =========================
// LOGOUT
// =========================
router.post("/logout", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.sendStatus(204);

  try {
    const user = await User.findOne({ refreshToken });
    if (user) {
      user.refreshToken = null;
      await user.save();
    }
    res.sendStatus(204);
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;