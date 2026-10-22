import assert from "node:assert/strict";
import test from "node:test";
import { getAccessiblePatientBranchIds } from "../src/utils/branchAccess.js";

test("active Enterprise access is limited to the user's available branches", () => {
  const branches = [{ id: "branch-a" }, { id: "branch-b" }];
  const user = {
    role: "doctor",
    branchId: "branch-a",
    clinic: {
      plan: "ENTERPRISE",
      paystackSubscriptionStatus: "active",
    },
    availableBranches: branches,
  };

  assert.deepEqual(getAccessiblePatientBranchIds(user), [
    "branch-a",
    "branch-b",
  ]);
});

test("single-branch staff do not inherit clinic-wide patient access", () => {
  const user = {
    role: "doctor",
    branchId: "branch-a",
    clinic: {
      plan: "ENTERPRISE",
      paystackSubscriptionStatus: "active",
    },
    availableBranches: [{ id: "branch-a" }],
  };

  assert.deepEqual(getAccessiblePatientBranchIds(user), ["branch-a"]);
});

test("expired Enterprise access is restricted to the active branch", () => {
  const user = {
    role: "doctor",
    branchId: "branch-a",
    clinic: {
      plan: "ENTERPRISE",
      paystackSubscriptionStatus: "cancelled",
      subscriptionEnds: "2020-01-01T00:00:00.000Z",
    },
    availableBranches: [{ id: "branch-a" }, { id: "branch-b" }],
  };

  assert.deepEqual(getAccessiblePatientBranchIds(user), ["branch-a"]);
});

test("users without an active branch have no patient branch scope", () => {
  assert.deepEqual(
    getAccessiblePatientBranchIds({
      role: "doctor",
      clinic: { plan: "ENTERPRISE", paystackSubscriptionStatus: "active" },
      availableBranches: [],
    }),
    [],
  );
});
