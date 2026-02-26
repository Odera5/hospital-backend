// models/record.model.js
import mongoose from "mongoose";

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
    investigation: { type: String, trim: true, default: "" },
    diagnosis: { type: String, trim: true, default: "" },
    treatmentPlan: { type: String, trim: true, default: "" },
    medication: { type: String, trim: true, default: "" },
  },
  { timestamps: true } // adds createdAt and updatedAt automatically
);

const Record = mongoose.model("Record", recordSchema);
export default Record;