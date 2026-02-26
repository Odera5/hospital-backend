// src/models/user.model.js
import mongoose from "mongoose";
import bcrypt from "bcrypt";

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      index: true,
    },

    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters"],
      select: false, // Hide password by default
    },

    role: {
      type: String,
      enum: ["nurse", "doctor", "admin"],
      required: true,
      default: "nurse",
    },

    refreshToken: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// =========================
// HASH PASSWORD BEFORE SAVE
// =========================
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// =========================
// COMPARE PASSWORD METHOD
// =========================
userSchema.methods.comparePassword = async function (enteredPassword) {
  if (!this.password) return false;
  return await bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model("User", userSchema);