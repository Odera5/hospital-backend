import assert from "node:assert/strict";
import test from "node:test";
import { authorizeBillingAccess } from "../src/middleware/authorize.js";

const checkAccess = (user) => {
  let statusCode;
  let responseBody;
  let nextCalled = false;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  authorizeBillingAccess(
    { user },
    response,
    () => {
      nextCalled = true;
    },
  );

  return { statusCode, responseBody, nextCalled };
};

test("billing permission allows staff while preserving their role", () => {
  for (const role of ["nurse", "doctor", "branch_manager"]) {
    assert.equal(
      checkAccess({ role, canAccessBilling: true }).nextCalled,
      true,
    );
  }
});

test("staff without billing permission are denied", () => {
  const result = checkAccess({ role: "nurse", canAccessBilling: false });

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
});

test("admins and legacy Billing Staff remain authorized", () => {
  assert.equal(
    checkAccess({ role: "admin", canAccessBilling: false }).nextCalled,
    true,
  );
  assert.equal(
    checkAccess({ role: "billing_staff", canAccessBilling: false }).nextCalled,
    true,
  );
});
