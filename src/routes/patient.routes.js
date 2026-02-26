import express from "express";
import fs from "fs";
import path from "path";
import Patient from "../models/patient.model.js";
import Record from "../models/record.model.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import upload from "../middleware/upload.js";

const router = express.Router();

// =========================
// PATIENT ROUTES
// =========================

// GET all active patients
router.get("/", protect, authorizeRoles("admin", "doctor", "nurse"), async (req, res) => {
  try {
    const patients = await Patient.find({ isDeleted: false }).sort({ createdAt: -1 });
    res.json(patients.map((p) => p.getDecrypted()));
  } catch (err) {
    console.error("Get patients error:", err);
    res.status(500).json({ message: "Failed to fetch patients" });
  }
});

// GET patient by ID
router.get("/:id", protect, authorizeRoles("admin", "doctor", "nurse"), async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient || patient.isDeleted) return res.status(404).json({ message: "Patient not found" });
    res.json(patient.getDecrypted());
  } catch (err) {
    console.error("Get patient error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// CREATE patient
router.post("/", protect, authorizeRoles("admin", "doctor", "nurse"), async (req, res) => {
  try {
    const { name, age, gender, phone, address, email } = req.body;
    if (!name?.trim() || !age) return res.status(400).json({ message: "Name and age are required" });

    const patient = new Patient({
      name: name.trim(),
      age: age.toString(),
      gender: gender || "other",
      phone: phone?.trim() || "",
      address: address?.trim() || "",
      email: email?.trim() || "",
    });

    await patient.save();
    res.status(201).json(patient.getDecrypted());
  } catch (err) {
    console.error("Create patient error:", err);
    res.status(500).json({ message: "Failed to create patient" });
  }
});

// UPDATE patient
router.put("/:id", protect, authorizeRoles("admin", "doctor"), async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient || patient.isDeleted) return res.status(404).json({ message: "Patient not found" });

    Object.assign(patient, req.body);
    await patient.save();
    res.json(patient.getDecrypted());
  } catch (err) {
    console.error("Update patient error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// =========================
// SOFT DELETE (Move to Trash) – allowed for all roles
// =========================
router.delete("/:id", protect, authorizeRoles("admin", "doctor", "nurse"), async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient || patient.isDeleted) return res.status(404).json({ message: "Patient not found" });

    patient.isDeleted = true;
    await patient.save();

    // Return decrypted patient object so frontend shows correct name immediately
    res.json({
      message: "Patient moved to Trash",
      patient: patient.getDecrypted(),
    });
  } catch (err) {
    console.error("Soft delete error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// GET all trashed patients – admin only
router.get("/trash/all", protect, authorizeRoles("admin"), async (req, res) => {
  try {
    const trash = await Patient.find({ isDeleted: true }).sort({ createdAt: -1 });
    res.json(trash.map((p) => p.getDecrypted()));
  } catch (err) {
    console.error("Get trash error:", err);
    res.status(500).json({ message: "Failed to fetch trash" });
  }
});

// RESTORE patient – admin only
router.put("/:id/restore", protect, authorizeRoles("admin"), async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient || !patient.isDeleted) return res.status(404).json({ message: "Patient not found in Trash" });

    patient.isDeleted = false;
    await patient.save();

    res.json({ message: "Patient restored successfully", patient: patient.getDecrypted() });
  } catch (err) {
    console.error("Restore patient error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// PERMANENT DELETE patient – admin only
router.delete("/:id/permanent", protect, authorizeRoles("admin"), async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ message: "Patient not found" });

    await Record.deleteMany({ patient: patient._id });
    await patient.deleteOne();
    res.json({ message: "Patient permanently deleted" });
  } catch (err) {
    console.error("Permanent delete error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// =========================
// PATIENT RECORDS
// =========================

// CREATE record with optional attachments
router.post(
  "/:id/records",
  protect,
  authorizeRoles("admin", "doctor", "nurse"),
  upload.array("attachments"),
  async (req, res) => {
    try {
      const patient = await Patient.findById(req.params.id);
      if (!patient || patient.isDeleted)
        return res.status(404).json({ message: "Patient not found" });

      const { presentingComplaint, diagnosis, treatmentPlan, history, examination, investigation, medication } = req.body;

      if (!presentingComplaint?.trim() || !diagnosis?.trim() || !treatmentPlan?.trim())
        return res.status(400).json({ message: "Complaint, diagnosis, and treatment plan are required" });

      const attachments = req.files?.map((file) => ({
        name: file.filename,
        url: `/uploads/records/${file.filename}`,
        mimetype: file.mimetype,
      }));

      const record = new Record({
        patient: patient._id,
        presentingComplaint,
        diagnosis,
        treatmentPlan,
        history,
        examination,
        investigation,
        medication,
        attachments,
      });

      await record.save();
      res.status(201).json(record);
    } catch (err) {
      console.error("Add record error:", err);
      res.status(500).json({ message: err.message || "Failed to add patient record" });
    }
  }
);

// UPDATE record (edit) + handle removed attachments
router.put(
  "/:id/records/:recordId",
  protect,
  authorizeRoles("admin", "doctor", "nurse"),
  upload.array("attachments"),
  async (req, res) => {
    try {
      const patient = await Patient.findById(req.params.id);
      if (!patient || patient.isDeleted)
        return res.status(404).json({ message: "Patient not found" });

      const record = await Record.findById(req.params.recordId);
      if (!record) return res.status(404).json({ message: "Record not found" });

      const {
        presentingComplaint,
        diagnosis,
        treatmentPlan,
        history,
        examination,
        investigation,
        medication,
        removedAttachments,
      } = req.body;

      // Remove deleted attachments
      if (removedAttachments) {
        const filenames = Array.isArray(removedAttachments) ? removedAttachments : [removedAttachments];
        filenames.forEach((name) => {
          const filePath = path.join("uploads", "records", name);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        });
        record.attachments = record.attachments.filter((att) => !filenames.includes(att.name));
      }

      // Add new attachments
      const newAttachments = req.files?.map((file) => ({
        name: file.filename,
        url: `/uploads/records/${file.filename}`,
        mimetype: file.mimetype,
      }));
      if (newAttachments?.length) record.attachments.push(...newAttachments);

      // Update text fields safely
      Object.assign(record, { presentingComplaint, diagnosis, treatmentPlan, history, examination, investigation, medication });

      await record.save();
      res.json(record);
    } catch (err) {
      console.error("Update record error:", err);
      res.status(500).json({ message: err.message || "Failed to update record" });
    }
  }
);

// GET all records for a patient
router.get("/:id/records", protect, authorizeRoles("admin", "doctor", "nurse"), async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient || patient.isDeleted) return res.status(404).json({ message: "Patient not found" });

    const records = await Record.find({ patient: patient._id }).sort({ createdAt: -1 });
    res.json(records);
  } catch (err) {
    console.error("Get records error:", err);
    res.status(500).json({ message: "Failed to fetch patient records" });
  }
});

// DELETE a record
router.delete("/:id/records/:recordId", protect, authorizeRoles("admin", "doctor"), async (req, res) => {
  try {
    const record = await Record.findById(req.params.recordId);
    if (!record) return res.status(404).json({ message: "Record not found" });

    record.attachments.forEach((att) => {
      const filePath = path.join("uploads", "records", att.name);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });

    await record.deleteOne();
    res.json({ message: "Record deleted successfully" });
  } catch (err) {
    console.error("Delete record error:", err);
    res.status(500).json({ message: "Failed to delete record" });
  }
});

export default router;