import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || "carechrome-test-encryption-key-32";

const { decryptPatientValue, encryptPatientValue, toEncryptedPatientData } =
  await import("../src/utils/patientCrypto.js");

test("patient values encrypt and decrypt without storing plaintext", () => {
  const patientName = "Mina Example";
  const encrypted = encryptPatientValue(patientName);

  assert.notEqual(encrypted, patientName);
  assert.equal(decryptPatientValue(encrypted), patientName);
});

test("encryption failures propagate instead of returning plaintext", () => {
  const originalCreateCipheriv = crypto.createCipheriv;
  crypto.createCipheriv = () => {
    throw new Error("simulated encryption failure");
  };

  try {
    assert.throws(
      () => encryptPatientValue("Sensitive patient data"),
      /simulated encryption failure/,
    );
  } finally {
    crypto.createCipheriv = originalCreateCipheriv;
  }
});

test("legacy plaintext values remain readable", () => {
  assert.equal(decryptPatientValue("Legacy: patient value"), "Legacy: patient value");
});

test("patient data serializer encrypts configured sensitive fields", () => {
  const data = toEncryptedPatientData({
    name: "Mina Example",
    cardNumber: "CC-123",
    age: "42",
    email: "mina@example.com",
    occupation: "Dentist",
  });

  assert.notEqual(data.name, "Mina Example");
  assert.notEqual(data.cardNumber, "CC-123");
  assert.notEqual(data.age, "42");
  assert.notEqual(data.email, "mina@example.com");
  assert.notEqual(data.occupation, "Dentist");
});
