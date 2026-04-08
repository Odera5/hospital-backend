import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: true,
    },
    appointmentDate: {
      type: Date,
      required: true,
    },
    timeSlot: {
      type: String, // e.g., "09:00", "10:00"
      required: true,
    },
    duration: {
      type: Number, // in minutes (30, 45, 60)
      default: 30,
    },
    appointmentType: {
      type: String,
      enum: [
        "checkup",
        "cleaning",
        "filling",
        "extraction",
        "root_canal",
        "other",
      ],
      default: "checkup",
    },
    dentistId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    notes: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["scheduled", "completed", "cancelled", "no_show"],
      default: "scheduled",
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// Index for quick lookup
appointmentSchema.index({ patientId: 1, appointmentDate: 1 });
appointmentSchema.index({ dentistId: 1, appointmentDate: 1 });

export default mongoose.model("Appointment", appointmentSchema);
