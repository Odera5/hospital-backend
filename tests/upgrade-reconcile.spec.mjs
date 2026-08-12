import assert from "assert";
import { prisma } from "../src/lib/prisma.js";
import { processPaystackWebhookEvent } from "../src/services/paystack.js";

console.log("Running upgrade reconciliation test...");

const unique = Date.now();
const testEmail = `upgrade-test-${unique}@example.com`;

let clinic;
let history;

try {
  try {
    const hasClinicCreate = Boolean(
      prisma && prisma.clinic && typeof prisma.clinic.create === "function",
    );
    if (!hasClinicCreate) {
      console.log(
        "Skipping DB-dependent upgrade reconciliation test: prisma client not available",
      );
      process.exit(0);
    }
  } catch (chkErr) {
    console.log(
      "Skipping DB-dependent upgrade reconciliation test: prisma client unstable",
      chkErr?.message,
    );
    process.exit(0);
  }
  clinic = await prisma.clinic.create({
    data: {
      name: `Upgrade Test ${unique}`,
      email: testEmail,
      plan: "PRO",
    },
  });

  const reference = `test-upgrade-${unique}`;

  history = await prisma.subscriptionHistory.create({
    data: {
      clinicId: clinic.id,
      actorId: null,
      fromPlan: "PRO",
      toPlan: "ENTERPRISE",
      fromInterval: "monthly",
      toInterval: "monthly",
      amount: 150000, // sample amount
      prorationCredit: 0,
      paystackReference: reference,
      status: "pending",
    },
  });

  const transaction = {
    reference,
    status: "success",
    paid_at: new Date().toISOString(),
    amount: 15000000,
    customer: { email: testEmail },
    metadata: { clinicId: clinic.id },
  };

  const event = { event: "charge.success", data: transaction };

  const result = await processPaystackWebhookEvent(event);

  const refreshedHistory = await prisma.subscriptionHistory.findUnique({
    where: { id: history.id },
  });
  const refreshedClinic = await prisma.clinic.findUnique({
    where: { id: clinic.id },
  });

  assert.strictEqual(
    refreshedHistory.status,
    "completed",
    "SubscriptionHistory should be completed",
  );
  assert.strictEqual(
    refreshedClinic.plan,
    "ENTERPRISE",
    "Clinic plan should be upgraded to ENTERPRISE",
  );

  console.log("✓ upgrade reconciliation passes");
} catch (err) {
  console.error("Upgrade reconciliation test failed:", err);
  process.exitCode = 1;
} finally {
  try {
    if (history)
      await prisma.subscriptionHistory.delete({ where: { id: history.id } });
    if (clinic) await prisma.clinic.delete({ where: { id: clinic.id } });
  } catch (cleanupErr) {
    // ignore cleanup errors
  }
}

console.log("Upgrade reconciliation tests completed.");
