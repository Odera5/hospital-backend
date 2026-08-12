import assert from "assert";
import crypto from "crypto";
import { fileURLToPath } from "url";
import path from "path";

// ensure we can import the service
import {
  verifyPaystackSignature,
  computeSubscriptionEndDate,
} from "../src/services/paystack.js";

console.log("Running paystack unit tests...");

// Test verifyPaystackSignature
const secret = "test_paystack_secret";
process.env.PAYSTACK_SECRET_KEY = secret;
const payload = { event: "charge.success", data: { foo: "bar" } };
const rawBody = Buffer.from(JSON.stringify(payload));
const signature = crypto
  .createHmac("sha512", secret)
  .update(rawBody)
  .digest("hex");

assert.strictEqual(
  verifyPaystackSignature(rawBody, signature),
  true,
  "Signature should verify",
);
console.log("✓ verifyPaystackSignature passes");

// Test computeSubscriptionEndDate (monthly/annually)
const paidAt = new Date("2026-08-01T00:00:00Z").toISOString();
const monthlyEnd = computeSubscriptionEndDate({ paidAt, interval: "monthly" });
const annualEnd = computeSubscriptionEndDate({ paidAt, interval: "annually" });

const monthlyExpected = new Date("2026-09-01T00:00:00Z").toISOString();
const annualExpected = new Date("2027-08-01T00:00:00Z").toISOString();

assert.strictEqual(
  new Date(monthlyEnd).toISOString(),
  monthlyExpected,
  "Monthly interval should add 1 month",
);
assert.strictEqual(
  new Date(annualEnd).toISOString(),
  annualExpected,
  "Annual interval should add 12 months",
);
console.log("✓ computeSubscriptionEndDate passes");

console.log("All paystack tests passed.");
