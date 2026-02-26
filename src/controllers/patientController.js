import Patient from "../models/patient.model.js";
import Record from "../models/record.model.js";
import fs from "fs";
import path from "path";

// =========================
// PATIENTS
// =========================

// GET single patient
export const getPatient = async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient || patient.isDeleted)
      return res.status(404).json({ message: "Patient not found" });

    res.json(patient.getDecrypted());
  } catch (err) {
    console.error("Get patient error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// GET all patients
export const getAllPatients = async (req, res) => {
  try {
    const patients = await Patient.find({ isDeleted: false }).sort({ createdAt: -1 });
    res.json(patients.map((p) => p.getDecrypted()));
  } catch (err) {
    console.error("Get all patients error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// CREATE new patient
export const createPatient = async (req, res) => {
  try {
    const { name, age, gender, email, phone, address } = req.body;
    if (!name || !age) return res.status(400).json({ message: "Name and age required" });

    const patient = new Patient({
      name: name.trim(),
      age: age.toString(),
      gender: gender || "other",
      email: email?.trim() || "",
      phone: phone?.trim() || "",
      address: address?.trim() || "",
      isDeleted: false,
    });

    await patient.save();
    res.status(201).json(patient.getDecrypted());
  } catch (err) {
    console.error("Create patient error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// UPDATE patient
export const updatePatient = async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient || patient.isDeleted)
      return res.status(404).json({ message: "Patient not found" });

    ["name", "age", "gender", "email", "phone", "address"].forEach((field) => {
      if (req.body[field] !== undefined) patient[field] = req.body[field];
    });

    await patient.save();
    res.json(patient.getDecrypted());
  } catch (err) {
    console.error("Update patient error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// =========================
// SOFT DELETE patient (move to trash) – allowed for all roles
// =========================
export const deletePatient = async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient || patient.isDeleted)
      return res.status(404).json({ message: "Patient not found" });

    patient.isDeleted = true;
    await patient.save();
    res.json({ message: "Patient moved to Trash", patient: patient.getDecrypted() });
  } catch (err) {
    console.error("Delete patient error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
};

// =========================
// RECORDS (with attachments support)
// =========================

// ADD a record
export const addRecord = async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient || patient.isDeleted)
      return res.status(404).json({ message: "Patient not found" });

    const {
      presentingComplaint,
      diagnosis,
      treatmentPlan,
      history,
      examination,
      investigation,
      medication,
    } = req.body;

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
    console.error("Add record error:", err.message);
    res.status(500).json({ message: err.message || "Server error" });
  }
};

// UPDATE a record
export const updateRecord = async (req, res) => {
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

    // Handle removed attachments
    if (removedAttachments) {
      const removed = Array.isArray(removedAttachments) ? removedAttachments : [removedAttachments];
      removed.forEach((filename) => {
        record.attachments = record.attachments.filter((att) => att.name !== filename);
        const filePath = path.join("uploads", "records", filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });
    }

    // Add new attachments
    const newAttachments = req.files?.map((file) => ({
      name: file.filename,
      url: `/uploads/records/${file.filename}`,
      mimetype: file.mimetype,
    }));
    if (newAttachments?.length) record.attachments.push(...newAttachments);

    // Update other fields
    Object.assign(record, {
      presentingComplaint,
      diagnosis,
      treatmentPlan,
      history,
      examination,
      investigation,
      medication,
    });

    await record.save();
    res.json(record);
  } catch (err) {
    console.error("Update record error:", err.message);
    res.status(500).json({ message: err.message || "Server error" });
  }
};

// DELETE a record
export const deleteRecord = async (req, res) => {
  try {
    const record = await Record.findById(req.params.recordId);
    if (!record) return res.status(404).json({ message: "Record not found" });

    // Delete attachments from filesystem
    if (record.attachments?.length) {
      record.attachments.forEach((att) => {
        const filePath = path.join("uploads", "records", att.name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });
    }

    await record.deleteOne();
    res.json({ message: "Record deleted successfully", record });
  } catch (err) {
    console.error("Delete record error:", err.message);
    res.status(500).json({ message: err.message || "Server error" });
  }
};