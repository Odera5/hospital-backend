import express from "express";
import { verifyToken } from "../middleware/verifyToken.js";
import {
  getAllAppointments,
  getAppointment,
  createAppointment,
  updateAppointment,
  deleteAppointment,
  getAvailableSlots,
} from "../controllers/appointmentController.js";

const router = express.Router();

// All routes require authentication
router.use(verifyToken);

// GET routes
router.get("/", getAllAppointments);
router.get("/available-slots", getAvailableSlots);
router.get("/:id", getAppointment);

// POST route
router.post("/", createAppointment);

// PUT route
router.put("/:id", updateAppointment);

// DELETE route
router.delete("/:id", deleteAppointment);

export default router;
