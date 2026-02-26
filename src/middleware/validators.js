// backend/middleware/validators.js
import { body, validationResult } from "express-validator";

// =========================
// Patient validation
// =========================
export const validatePatient = [
  // Name: required, trimmed
  body("name")
    .trim()
    .notEmpty()
    .withMessage("Name is required"),

  // Age: required, integer 0-120
  body("age")
    .notEmpty()
    .withMessage("Age is required")
    .isInt({ min: 0, max: 120 })
    .withMessage("Age must be a number between 0 and 120"),

  // Email: optional but must be valid if provided
  body("email")
    .optional({ checkFalsy: true })
    .isEmail()
    .withMessage("Invalid email address")
    .normalizeEmail(),

  // Gender: optional, but only allowed values
  body("gender")
    .optional({ checkFalsy: true })
    .isIn(["male", "female", "other", "Not specified"])
    .withMessage("Gender must be male, female, other, or Not specified"),

  // Phone: optional, must be valid string (digits, +, -, (), space)
  body("phone")
    .optional({ checkFalsy: true })
    .matches(/^[0-9+\-() ]*$/)
    .withMessage("Phone contains invalid characters"),

  // Address: optional, must be string if provided
  body("address")
    .optional({ checkFalsy: true })
    .isString()
    .withMessage("Address must be text"),

  // Middleware to catch validation errors
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Return first error for clarity
      return res.status(400).json({ message: errors.array()[0].msg });
    }
    next();
  },
];

// =========================
// Record validation
// =========================
export const validateRecord = [
  body("title")
    .trim()
    .notEmpty()
    .withMessage("Record title is required"),

  body("description")
    .optional({ checkFalsy: true })
    .isString()
    .withMessage("Description must be text"),

  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }
    next();
  },
];
