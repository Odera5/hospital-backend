import assert from "assert";
import crypto from "crypto";
import { fileURLToPath } from "url";
import path from "path";

// ensure we can import the service
import {
  verifyPaystackSignature,
  computeSubscriptionEndDate,
  computeSubscriptionEndDateForClinic,
  createScheduledPaystackSubscription,
  wasPaystackTransactionAlreadyApplied,
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

const trialPeriodEnd = "2030-12-06T00:00:00.000Z";
const paymentDate = "2030-11-22T00:00:00.000Z";
const firstSubscriptionEnd = computeSubscriptionEndDateForClinic({
  clinic: { subscriptionEnds: new Date(trialPeriodEnd) },
  paidAt: paymentDate,
  interval: "monthly",
});
assert.strictEqual(
  new Date(firstSubscriptionEnd).toISOString(),
  "2030-12-22T00:00:00.000Z",
  "A first paid subscription should start from payment date, not stack unused trial time",
);

const renewedSubscriptionEnd = computeSubscriptionEndDateForClinic({
  clinic: {
    subscriptionEnds: new Date(trialPeriodEnd),
    paystackSubscriptionStatus: "cancelled",
  },
  paidAt: paymentDate,
  interval: "monthly",
});
assert.strictEqual(
  new Date(renewedSubscriptionEnd).toISOString(),
  "2031-01-06T00:00:00.000Z",
  "Renewal should preserve remaining time from an existing paid subscription",
);

assert.strictEqual(
  wasPaystackTransactionAlreadyApplied(
    {
      paystackLastReference: "previous-reference",
      paystackSubscriptionStatus: "non-renewing",
      subscriptionEnds: new Date(trialPeriodEnd),
    },
    "renewal-reference",
  ),
  false,
  "A new checkout on a non-renewing subscription must not be mistaken for an already-applied payment",
);
assert.strictEqual(
  wasPaystackTransactionAlreadyApplied(
    {
      paystackLastReference: "renewal-reference",
      paystackSubscriptionStatus: "active",
      subscriptionEnds: new Date("2031-01-06T00:00:00.000Z"),
    },
    "renewal-reference",
  ),
  true,
  "A successfully applied payment should not extend access twice",
);
assert.strictEqual(
  wasPaystackTransactionAlreadyApplied(
    {
      paystackLastReference: "renewal-reference",
      paystackSubscriptionStatus: "non-renewing",
      subscriptionEnds: new Date("2031-01-06T00:00:00.000Z"),
    },
    "renewal-reference",
  ),
  true,
  "An applied payment should remain idempotent when auto-renew is disabled",
);

const originalFetch = globalThis.fetch;
let scheduledSubscriptionRequest;
globalThis.fetch = async (url, options) => {
  scheduledSubscriptionRequest = { url, options };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: true,
      data: {
        subscription_code: "SUB_scheduled",
        email_token: "scheduled-token",
      },
    }),
  };
};

try {
  const scheduledStartDate = "2030-12-06T00:00:00.000Z";
  const scheduledSubscription = await createScheduledPaystackSubscription({
    clinic: {
      paystackCustomerCode: "CUS_test",
      paystackPlanCode: "PLN_test",
      paystackAuthorizationCode: "AUTH_test",
    },
    startDate: scheduledStartDate,
  });
  const requestBody = JSON.parse(scheduledSubscriptionRequest.options.body);

  assert.strictEqual(
    scheduledSubscriptionRequest.url,
    "https://api.paystack.co/subscription",
    "Scheduled billing should create a Paystack subscription",
  );
  assert.strictEqual(requestBody.start_date, scheduledStartDate);
  assert.strictEqual(requestBody.authorization, "AUTH_test");
  assert.strictEqual(
    scheduledSubscription.start_date,
    scheduledStartDate,
    "Use the requested date when Paystack does not return next_payment_date",
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("✓ first purchase, paid renewal, idempotency, and scheduling pass");

console.log("All paystack tests passed.");
