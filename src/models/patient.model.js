// models/patient.model.js
import mongoose from "mongoose";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

// =========================
// ENCRYPTION SETUP
// =========================
const algorithm = "aes-256-cbc";
const ENCRYPTION_KEY = (process.env.ENCRYPTION_KEY || "32charslongsecretkey1234567890")
  .padEnd(32, "0")
  .slice(0, 32);
const IV_LENGTH = 16;

// =========================
// ENCRYPT / DECRYPT FUNCTIONS
// =========================
function encrypt(text) {
  if (!text || typeof text !== "string") return text;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(algorithm, Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text, "utf8");
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString("hex") + ":" + encrypted.toString("hex");
  } catch (err) {
    console.error("Encryption error:", err);
    return text;
  }
}

function decrypt(text) {
  if (!text || typeof text !== "string") return text;
  try {
    const [ivHex, encryptedHex] = text.split(":");
    if (!ivHex || !encryptedHex) return text;

    const iv = Buffer.from(ivHex, "hex");
    const encryptedText = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv(algorithm, Buffer.from(ENCRYPTION_KEY), iv);

    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString();
  } catch (err) {
    console.error("Decryption error:", err);
    return text;
  }
}

// =========================
// RECORD SCHEMA
// =========================
const recordSchema = new mongoose.Schema({
  presentingComplaint: { type: String, default: "" },
  history: { type: String, default: "" },
  examination: { type: String, default: "" },
  investigation: { type: String, default: "" },
  diagnosis: { type: String, default: "" },
  treatmentPlan: { type: String, default: "" },
  medication: { type: String, default: "" },
  attachments: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
});

// =========================
// PATIENT SCHEMA
// =========================
const patientSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    age: { type: Number, required: true },
    email: { type: String, default: "" },
    gender: { type: String, enum: ["male", "female", "other"], default: "other" },
    phone: { type: String, default: "" },
    address: { type: String, default: "" },
    isDeleted: { type: Boolean, default: false },
    records: { type: [recordSchema], default: [] },
  },
  { timestamps: true }
);

// =========================
// PRE-SAVE ENCRYPTION
// =========================
patientSchema.pre("save", function () {
  // No next() needed for modern Mongoose
  if (this.isModified("name") && this.name) this.name = encrypt(this.name);
  if (this.isModified("age") && this.age !== undefined) this.age = encrypt(this.age.toString());
  if (this.isModified("email") && this.email) this.email = encrypt(this.email);
});

// =========================
// DECRYPTED PATIENT METHOD
// =========================
patientSchema.methods.getDecrypted = function () {
  try {
    return {
      _id: this._id,
      name: typeof this.name === "string" ? decrypt(this.name) : this.name || "",
      age: typeof this.age === "string" ? parseInt(decrypt(this.age)) : this.age || 0,
      email: typeof this.email === "string" ? decrypt(this.email) : this.email || "",
      gender: this.gender || "other",
      phone: this.phone || "",
      address: this.address || "",
      isDeleted: this.isDeleted || false,
      records: Array.isArray(this.records) ? this.records : [],
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  } catch (err) {
    console.error("Decryption failed for patient", this._id, err);
    return {
      _id: this._id,
      name: this.name || "",
      age: this.age || 0,
      email: this.email || "",
      gender: this.gender || "other",
      phone: this.phone || "",
      address: this.address || "",
      isDeleted: this.isDeleted || false,
      records: Array.isArray(this.records) ? this.records : [],
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
};

export default mongoose.model("Patient", patientSchema);