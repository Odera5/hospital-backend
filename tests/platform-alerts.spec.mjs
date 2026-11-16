import assert from "node:assert/strict";
import test from "node:test";
import {
  sendAdminPermanentDeletionAlert,
} from "../src/services/emailVerification.js";
import { notifyAdminOperationalIssue } from "../src/services/platformAlertService.js";

const withResend = async (testBody) => {
  const env = {
    ADMIN_NOTIFICATION_EMAIL: process.env.ADMIN_NOTIFICATION_EMAIL,
    EMAIL_FROM: process.env.EMAIL_FROM,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
  };
  const originalFetch = globalThis.fetch;
  const requests = [];

  process.env.ADMIN_NOTIFICATION_EMAIL = "alerts@example.test";
  process.env.EMAIL_FROM = "carechrome@example.test";
  process.env.RESEND_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true };
  };

  try {
    await testBody(requests);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("permanent-deletion alerts omit patient names and deletion reasons", async () => {
  await withResend(async (requests) => {
    await sendAdminPermanentDeletionAlert({
      clinicId: "clinic-1",
      actorEmail: "admin@example.test",
      resourceType: "patient charts",
      affectedCount: 2,
      patientName: "Example Patient",
      reason: "Sensitive clinical detail",
    });

    assert.equal(requests.length, 1);
    assert.match(requests[0].body.text, /clinic-1/);
    assert.match(requests[0].body.text, /admin@example\.test/);
    assert.doesNotMatch(requests[0].body.text, /Example Patient|Sensitive clinical detail/);
  });
});

test("repeated operational failures are rate-limited per component", async () => {
  await withResend(async (requests) => {
    const source = `test component ${Date.now()}`;

    assert.equal(await notifyAdminOperationalIssue(source), true);
    assert.equal(await notifyAdminOperationalIssue(source), false);
    assert.equal(requests.length, 1);
  });
});
