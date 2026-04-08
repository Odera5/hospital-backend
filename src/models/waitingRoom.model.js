import mongoose from "mongoose";

const waitingRoomSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: true,
    },
    patientName: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["waiting", "called", "in_consultation", "completed"],
      default: "waiting",
    },
    notes: {
      type: String,
      default: "",
    },
    arrivalTime: {
      type: Date,
      default: Date.now,
    },
    calledAt: {
      type: Date,
    },
    consultationStartedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
    order: {
      type: Number,
      default: () => Date.now(),
    },
  },
  { timestamps: true },
);

waitingRoomSchema.index({ status: 1, order: 1 });

export default mongoose.model("WaitingRoom", waitingRoomSchema);
