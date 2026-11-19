import assert from "node:assert/strict";
import { test } from "node:test";
import { permanentDeletionDisabled } from "../src/middleware/permanentDeletionDisabled.js";

test("permanent deletion responds as disabled without deleting data", () => {
  let statusCode;
  let responseBody;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  permanentDeletionDisabled({}, res);

  assert.equal(statusCode, 410);
  assert.match(responseBody.message, /Permanent deletion is disabled/);
  assert.match(responseBody.message, /remains in Trash/);
});
