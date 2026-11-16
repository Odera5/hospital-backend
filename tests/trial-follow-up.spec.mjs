import assert from "node:assert/strict";
import test from "node:test";
import { getTrialFollowUpMilestone } from "../src/services/trialFollowUpService.js";

test("trial follow-up milestones use the nearest due reminder", () => {
  assert.equal(getTrialFollowUpMilestone(8), null);
  assert.equal(getTrialFollowUpMilestone(7), "7_days");
  assert.equal(getTrialFollowUpMilestone(4), "7_days");
  assert.equal(getTrialFollowUpMilestone(3), "3_days");
  assert.equal(getTrialFollowUpMilestone(2), "3_days");
  assert.equal(getTrialFollowUpMilestone(1), "1_day");
  assert.equal(getTrialFollowUpMilestone(0), "expired");
  assert.equal(getTrialFollowUpMilestone(-1), "expired");
});
