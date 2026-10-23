import { prisma } from "../lib/prisma.js";
import { decryptPatientValue } from "../utils/patientCrypto.js";

const BACKFILL_BATCH_SIZE = 200;

const normalizeSearchValue = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

export const buildPatientSearchIndexData = ({
  name = "",
  cardNumber = "",
  age = "",
} = {}) => {
  const normalizedAge = Number.parseInt(String(age ?? "").trim(), 10);

  return {
    searchName: normalizeSearchValue(name),
    searchCardNumber: normalizeSearchValue(cardNumber),
    ageNumber: Number.isFinite(normalizedAge) ? normalizedAge : 0,
  };
};

export const buildPatientSearchIndexDataFromRow = (patient) =>
  buildPatientSearchIndexData({
    name: decryptPatientValue(patient?.name),
    cardNumber: decryptPatientValue(patient?.cardNumber),
    age: decryptPatientValue(patient?.age),
  });

export const backfillPatientSearchIndexes = async ({
  clinicId,
  batchSize = BACKFILL_BATCH_SIZE,
} = {}) => {
  let cursor;
  let processed = 0;

  while (true) {
    const patients = await prisma.patient.findMany({
      where: {
        ...(clinicId ? { clinicId } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
        OR: [
          { searchName: null },
          { searchCardNumber: null },
          { ageNumber: null },
        ],
      },
      orderBy: { id: "asc" },
      take: batchSize,
      select: {
        id: true,
        name: true,
        cardNumber: true,
        age: true,
      },
    });

    if (patients.length === 0) {
      return processed;
    }

    const updates = patients.map((patient) =>
      prisma.patient.updateMany({
        where: {
          id: patient.id,
          searchName: patient.searchName,
          searchCardNumber: patient.searchCardNumber,
          ageNumber: patient.ageNumber,
        },
        data: buildPatientSearchIndexDataFromRow(patient),
      }),
    );

    const results = await prisma.$transaction(updates);
    processed += results.reduce((total, result) => total + result.count, 0);
    cursor = patients[patients.length - 1]?.id;
  }
};

let startupBackfillPromise = null;

export const ensurePatientSearchIndexesBackfilled = () => {
  if (!startupBackfillPromise) {
    startupBackfillPromise = backfillPatientSearchIndexes()
      .then((count) => {
        if (count > 0) {
          console.log(`Backfilled patient search indexes for ${count} patients.`);
        }
      })
      .catch((error) => {
        console.error("Patient search index backfill failed:", error);
      });
  }

  return startupBackfillPromise;
};
