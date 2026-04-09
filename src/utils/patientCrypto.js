import crypto from "crypto";

const algorithm = "aes-256-cbc";
const rawEncryptionKey = process.env.ENCRYPTION_KEY;
const IV_LENGTH = 16;

if (!rawEncryptionKey) {
  throw new Error("ENCRYPTION_KEY is required");
}

const ENCRYPTION_KEY = Buffer.from(
  rawEncryptionKey.padEnd(32, "0").slice(0, 32),
);

function normalizePatientString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

export function encryptPatientValue(text) {
  if (!text || typeof text !== "string") return text;

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(algorithm, ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, "utf8");
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
  } catch (error) {
    console.error("Encryption error:", error);
    return text;
  }
}

export function decryptPatientValue(text) {
  if (!text || typeof text !== "string") return text;

  try {
    const [ivHex, encryptedHex] = text.split(":");
    if (!ivHex || !encryptedHex) return text;

    const iv = Buffer.from(ivHex, "hex");
    const encryptedText = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv(algorithm, ENCRYPTION_KEY, iv);

    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString();
  } catch (error) {
    console.error("Decryption error:", error);
    return text;
  }
}

export function toEncryptedPatientData(data = {}) {
  return {
    name: encryptPatientValue(normalizePatientString(data.name)),
    cardNumber: encryptPatientValue(normalizePatientString(data.cardNumber)),
    age: encryptPatientValue(normalizePatientString(data.age, "0")),
    email: encryptPatientValue(normalizePatientString(data.email)),
    gender: normalizePatientString(data.gender, "other") || "other",
    phone: normalizePatientString(data.phone),
    address: normalizePatientString(data.address),
  };
}

export function toDecryptedPatient(patient) {
  if (!patient) return null;

  const resolvedId = patient.id || patient._id || null;

  return {
    id: resolvedId,
    _id: resolvedId,
    ...patient,
    name:
      typeof patient.name === "string"
        ? decryptPatientValue(patient.name)
        : patient.name || "",
    cardNumber:
      typeof patient.cardNumber === "string"
        ? decryptPatientValue(patient.cardNumber)
        : patient.cardNumber || "",
    age:
      typeof patient.age === "string"
        ? parseInt(decryptPatientValue(patient.age), 10) || 0
        : Number(patient.age) || 0,
    email:
      typeof patient.email === "string"
        ? decryptPatientValue(patient.email)
        : patient.email || "",
    gender: patient.gender || "other",
    phone: patient.phone || "",
    address: patient.address || "",
    isDeleted: Boolean(patient.isDeleted),
  };
}
