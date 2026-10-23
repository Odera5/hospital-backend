import assert from "node:assert/strict";
import { test } from "node:test";
import { syncClinicalHistoryFromRecord } from "../src/services/patientClinicalHistory.js";

const createTransaction = (existingEntries = []) => {
  const entries = [...existingEntries];
  let nextId = 1;
  return {
    entries,
    patientClinicalHistory: {
      findFirst: async ({ where }) =>
        entries.find(
          (entry) =>
            entry.patientId === where.patientId &&
            entry.category === where.category &&
            entry.status === where.status &&
            entry.value.toLowerCase() === where.value.equals.toLowerCase(),
        ) || null,
      create: async ({ data }) => {
        const entry = { id: `history-${nextId++}`, ...data };
        entries.push(entry);
        return { id: entry.id, category: entry.category };
      },
    },
  };
};

test("recording new allergies and comorbidities appends without replacing existing active entries", async () => {
  const transaction = createTransaction([
    {
      id: "existing",
      patientId: "patient-1",
      category: "allergy",
      value: "Aspirin",
      status: "active",
    },
  ]);

  const created = await syncClinicalHistoryFromRecord(transaction, {
    patientId: "patient-1",
    allergies: "Sulphur-containing medication",
    comorbidities: "Hypertension",
    recordedById: "clinician-1",
  });

  assert.deepEqual(
    transaction.entries.map(({ category, value }) => ({ category, value })),
    [
      { category: "allergy", value: "Aspirin" },
      { category: "allergy", value: "Sulphur-containing medication" },
      { category: "comorbidity", value: "Hypertension" },
    ],
  );
  assert.equal(created.length, 2);
});

test("recording a duplicate active entry does not create another row", async () => {
  const transaction = createTransaction([
    {
      id: "existing",
      patientId: "patient-1",
      category: "allergy",
      value: "Aspirin",
      status: "active",
    },
  ]);

  const created = await syncClinicalHistoryFromRecord(transaction, {
    patientId: "patient-1",
    allergies: " aspirin ",
    comorbidities: "",
  });

  assert.equal(created.length, 0);
  assert.equal(transaction.entries.length, 1);
});

test("blank and explicit no-known entries are not recorded as active conditions", async () => {
  const transaction = createTransaction();

  const created = await syncClinicalHistoryFromRecord(transaction, {
    patientId: "patient-1",
    allergies: "No known allergies",
    comorbidities: "None",
  });

  assert.deepEqual(created, []);
  assert.deepEqual(transaction.entries, []);
});
