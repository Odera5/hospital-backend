import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import { enforceSubscriptionState } from "../middleware/subscriptionStateGuard.js";
import {
  getAllAppointments,
  getAppointment,
  createAppointment,
  updateAppointment,
  deleteAppointment,
  getAvailableSlots,
  respondToAppointment,
} from "../controllers/appointmentController.js";
import { validateAppointment } from "../middleware/validators.js";

const router = express.Router();

router.post("/respond", respondToAppointment);

// All routes require authentication
router.use(verifyToken);
router.use(enforceSubscriptionState({ allowAdminReadOnly: true }));

// GET routes
router.get("/", getAllAppointments);
router.get("/available-slots", getAvailableSlots);
router.get("/:id", getAppointment);

// POST route
router.post("/", validateAppointment, createAppointment);

// PUT route
router.put("/:id", validateAppointment, updateAppointment);

// DELETE route
router.delete("/:id", deleteAppointment);

export default router;
