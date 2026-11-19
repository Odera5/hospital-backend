import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  deleteExpiredTrashedPatients,
  getTrashExpiryCutoff,
} from "../src/services/trashCleanupService.js";

const createDatabase = ({ patient, billingRecord = null, deleteCount = 1 }) => {
  const calls = {
    findMany: null,
    deleteMany: null,
    audits: [],
    invoiceLookups: 0,
  };
  const transaction = {
    invoice: {
      findFirst: async () => {
        calls.invoiceLookups += 1;
        return billingRecord;
      },
    },
    patient: {
      deleteMany: async (args) => {
        calls.deleteMany = args;
        return { count: deleteCount };
      },
    },
    auditLog: {
      create: async ({ data }) => calls.audits.push(data),
    },
  };

  return {
    calls,
    db: {
      patient: {
        findMany: async (args) => {
          calls.findMany = args;
          return patient ? [patient] : [];
        },
      },
      $transaction: async (callback) => callback(transaction),
    },
  };
};

test("six-month cutoff clamps to the last day of shorter months", () => {
  assert.equal(
    getTrashExpiryCutoff(new Date("2026-08-31T12:00:00.000Z")).toISOString(),
    "2026-02-28T12:00:00.000Z",
  );
});

test("expired charts without payment history are deleted, audited, and have attachments cleaned", async () => {
  const patient = {
    id: "patient-1",
    branchId: "branch-1",
    records: [{ attachments: [{ name: "record-file.png" }] }],
  };
  const { db, calls } = createDatabase({ patient });
  const objectKeys = [];
  const localPaths = [];
  const now = new Date("2026-08-31T12:00:00.000Z");

  const deletedCount = await deleteExpiredTrashedPatients({
    now,
    db,
    deleteObject: async (key) => objectKeys.push(key),
    unlinkFile: async (filePath) => localPaths.push(filePath),
  });

  assert.equal(deletedCount, 1);
  assert.equal(calls.findMany.where.isDeleted, true);
  assert.equal(
    calls.findMany.where.deletedAt.lte.toISOString(),
    getTrashExpiryCutoff(now).toISOString(),
  );
  assert.deepEqual(calls.findMany.where.invoices, { none: {} });
  assert.equal(calls.findMany.take, 100);
  assert.equal(calls.deleteMany.where.isDeleted, true);
  assert.equal(calls.audits.length, 1);
  assert.equal(calls.audits[0].actorRole, "system");
  assert.equal(calls.audits[0].metadata.automatic, true);
  assert.deepEqual(objectKeys, ["records/record-file.png"]);
  assert.ok(
    localPaths[0].endsWith(
      path.join("uploads", "records", "record-file.png"),
    ),
  );
});

test("charts with billing records remain in Trash", async () => {
  const patient = {
    id: "patient-1",
    branchId: "branch-1",
    records: [],
  };
  const { db, calls } = createDatabase({
    patient,
    billingRecord: { id: "invoice-1" },
  });
  const deletedCount = await deleteExpiredTrashedPatients({
    db,
    deleteObject: async () => {},
    unlinkFile: async () => {},
  });

  assert.equal(deletedCount, 0);
  assert.equal(calls.deleteMany, null);
  assert.equal(calls.audits.length, 0);
});

test("a chart restored before its deletion transaction is left untouched", async () => {
  const patient = {
    id: "patient-1",
    branchId: "branch-1",
    records: [{ attachments: [{ name: "record-file.png" }] }],
  };
  const { db, calls } = createDatabase({ patient, deleteCount: 0 });
  const objectKeys = [];
  const deletedCount = await deleteExpiredTrashedPatients({
    db,
    deleteObject: async (key) => objectKeys.push(key),
    unlinkFile: async () => {},
  });

  assert.equal(deletedCount, 0);
  assert.equal(calls.audits.length, 0);
  assert.deepEqual(objectKeys, []);
});
