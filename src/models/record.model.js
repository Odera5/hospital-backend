// models/record.model.js
import mongoose from "mongoose";

const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    mimetype: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const toothSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true },
    condition: {
      type: String,
      enum: ["present", "carious", "tender", "mobile", "fractured", "missing"],
      default: "present",
    },
  },
  { _id: false }
);

const recordSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: [true, "Patient ID is required"],
    },
    presentingComplaint: {
      type: String,
      required: [true, "Presenting complaint is required"],
      trim: true,
    },
    history: { type: String, trim: true, default: "" },
    examination: { type: String, trim: true, default: "" },
    examinationExtraOral: { type: String, trim: true, default: "" },
    softTissue: { type: String, trim: true, default: "" },
    periodontalStatus: { type: String, trim: true, default: "" },
    occlusion: { type: String, trim: true, default: "" },
    investigation: { type: String, trim: true, default: "" },
    diagnosis: { type: String, trim: true, default: "" },
    treatmentPlan: { type: String, trim: true, default: "" },
    medication: { type: String, trim: true, default: "" },
    dentition: {
      type: String,
      enum: ["adult", "child"],
      default: "adult",
    },
    teeth: { type: [toothSchema], default: [] },
    attachments: { type: [attachmentSchema], default: [] },
  },
  { timestamps: true } // adds createdAt and updatedAt automatically
);

const Record = mongoose.model("Record", recordSchema);
export default Record;
