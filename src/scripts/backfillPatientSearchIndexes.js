import dotenv from "dotenv";
import { prisma } from "../lib/prisma.js";
import { backfillPatientSearchIndexes } from "../services/patientSearchIndex.js";

dotenv.config();

const main = async () => {
  const count = await backfillPatientSearchIndexes();
  console.log(`Backfilled patient search indexes for ${count} patients.`);
};

main()
  .catch((error) => {
    console.error("Failed to backfill patient search indexes:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
