import { body, query, param, validationResult } from "express-validator";

// =========================
// Generic Error Handler
// =========================
export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Return first error for clarity
    return res.status(400).json({ message: errors.array()[0].msg });
  }
  next();
};

// =========================
// Auth / Clinic Validation
// =========================
export const validateClinicRegistration = [
  body("clinicName").trim().notEmpty().withMessage("Clinic name is required"),
  body("clinicEmail").trim().notEmpty().withMessage("Clinic email is required").isEmail().withMessage("Invalid clinic email address"),
  body("clinicCountry").trim().notEmpty().withMessage("Clinic country is required"),
  body("clinicCity").trim().notEmpty().withMessage("Clinic city is required"),
  body("adminName").trim().notEmpty().withMessage("Admin name is required"),
  body("adminEmail").trim().notEmpty().withMessage("Admin email is required").isEmail().withMessage("Invalid admin email address"),
  body("password").notEmpty().withMessage("Password is required").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
  handleValidationErrors,
];

export const validateSignup = [
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("email").trim().notEmpty().withMessage("Email is required").isEmail().withMessage("Invalid email address"),
  body("password").notEmpty().withMessage("Password is required").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
  body("role").optional().isIn(["branch_manager", "doctor", "nurse"]).withMessage("Invalid role"),
  body("assignedBranchIds").optional().isArray().withMessage("Assigned branches must be an array"),
  body("assignedBranchIds.*").optional().isString().withMessage("Assigned branch IDs must be strings"),
  handleValidationErrors,
];

export const validateLogin = [
  body("email").trim().notEmpty().withMessage("Email is required").isEmail().withMessage("Invalid email address"),
  body("password").notEmpty().withMessage("Password is required"),
  handleValidationErrors,
];

export const validateClinicProfileUpdate = [
  body("clinicName").trim().notEmpty().withMessage("Clinic name is required"),
  body("clinicEmail").trim().notEmpty().withMessage("Clinic email is required").isEmail().withMessage("Invalid clinic email address"),
  body("clinicPhone").optional({ checkFalsy: true }).isString(),
  body("clinicCountry").optional({ checkFalsy: true }).isString(),
  body("clinicCity").optional({ checkFalsy: true }).isString(),
  body("clinicAddress").optional({ checkFalsy: true }).isString(),
  body("contactPerson").optional({ checkFalsy: true }).isString(),
  body("reminderOffsets").optional().isArray(),
  body("reminderOffsets.*").optional().isInt({ min: 1 }),
  handleValidationErrors,
];

export const validateBranchPayload = [
  body("name").trim().notEmpty().withMessage("Branch name is required"),
  body("city").trim().notEmpty().withMessage("Branch city is required"),
  body("area").trim().notEmpty().withMessage("Branch area is required"),
  body("country").optional({ checkFalsy: true }).isString(),
  body("address").optional({ checkFalsy: true }).isString(),
  body("phone").optional({ checkFalsy: true }).isString(),
  body("isActive").optional().isBoolean(),
  handleValidationErrors,
];

// =========================
// Patient validation
// =========================
export const validatePatient = [
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("age").notEmpty().withMessage("Age is required").isInt({ min: 0, max: 120 }).withMessage("Age must be a number between 0 and 120"),
  body("email").optional({ checkFalsy: true }).isEmail().withMessage("Invalid email address").normalizeEmail(),
  body("gender").optional({ checkFalsy: true }).isIn(["male", "female", "other", "Not specified"]).withMessage("Gender must be male, female, other, or Not specified"),
  body("phone").optional({ checkFalsy: true }).matches(/^[0-9+\-() ]*$/).withMessage("Phone contains invalid characters"),
  body("address").optional({ checkFalsy: true }).isString().withMessage("Address must be text"),
  handleValidationErrors,
];

// =========================
// Record validation
// =========================
export const validateRecord = [
  body("title").trim().notEmpty().withMessage("Record title is required"),
  body("description").optional({ checkFalsy: true }).isString().withMessage("Description must be text"),
  handleValidationErrors,
];

// =========================
// Appointment validation
// =========================
export const validateAppointmentCreate = [
  body("patientId").notEmpty().withMessage("Patient ID is required"),
  body("appointmentDate").notEmpty().withMessage("Date is required").isISO8601().withMessage("Invalid date format"),
  body("timeSlot").notEmpty().withMessage("Time is required"),
  body("appointmentType").notEmpty().withMessage("Appointment type is required"),
  body("dentistId").optional({ checkFalsy: true }).isString(),
  handleValidationErrors,
];

export const validateAppointmentUpdate = [
  body("patientId").optional().notEmpty().withMessage("Patient ID cannot be empty if provided"),
  body("appointmentDate").optional().isISO8601().withMessage("Invalid date format"),
  body("timeSlot").optional().notEmpty().withMessage("Time cannot be empty if provided"),
  body("appointmentType").optional().notEmpty().withMessage("Appointment type cannot be empty if provided"),
  body("dentistId").optional({ checkFalsy: true }).isString(),
  body("status").optional().isString(),
  handleValidationErrors,
];

// =========================
// Intake validation
// =========================
export const validatePublicIntake = [
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("age").notEmpty().withMessage("Age is required").isInt({ min: 0, max: 120 }).withMessage("Age must be a number between 0 and 120"),
  body("email").optional({ checkFalsy: true }).isEmail().withMessage("Invalid email address").normalizeEmail(),
  body("gender").optional({ checkFalsy: true }).isIn(["male", "female", "other", "Not specified"]).withMessage("Gender must be male, female, other, or Not specified"),
  body("phone").optional({ checkFalsy: true }).matches(/^[0-9+\-() ]*$/).withMessage("Phone contains invalid characters"),
  body("address").optional({ checkFalsy: true }).isString().withMessage("Address must be text"),
  body("preferredDate").optional({ checkFalsy: true }).isISO8601().withMessage("Invalid date format"),
  body("preferredTime").optional({ checkFalsy: true }).isString(),
  handleValidationErrors,
];

// =========================
// Billing validation
// =========================
export const validatePaystackInitialization = [
  body("interval").optional().isIn(["monthly", "annually"]).withMessage("Interval must be monthly or annually"),
  body("plan").optional().isIn(["PRO", "ENTERPRISE"]).withMessage("Plan must be PRO or ENTERPRISE"),
  handleValidationErrors,
];

export const validatePaystackVerify = [
  query("reference").optional({ checkFalsy: true }).isString().withMessage("Reference must be a string"),
  body("reference").optional({ checkFalsy: true }).isString().withMessage("Reference must be a string"),
  handleValidationErrors,
];

// =========================
// Invoice validation
// =========================
export const validateInvoice = [
  body("patientId").notEmpty().withMessage("Patient ID is required"),
  body("items").isArray({ min: 1 }).withMessage("Invoice must have at least one item"),
  body("items.*.description").notEmpty().withMessage("Item description is required"),
  body("items.*.quantity").isInt({ min: 1 }).withMessage("Item quantity must be at least 1"),
  body("items.*.unitPrice").isFloat({ min: 0 }).withMessage("Item unit price cannot be negative"),
  body("dueDate").optional({ checkFalsy: true }).isISO8601().withMessage("Invalid date format"),
  handleValidationErrors,
];
