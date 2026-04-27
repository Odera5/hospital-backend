import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  try {
    // Attempt to add missing columns to Record
    console.log("Adding columns to Record...");
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Record" 
      ADD COLUMN IF NOT EXISTS "allergies" TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS "comorbidities" TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS "currentMedication" TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false;
    `);
    console.log("Record columns added successfully.");

    // Attempt to add logoUrl to Clinic just in case
    console.log("Adding logoUrl to Clinic...");
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Clinic" ADD COLUMN IF NOT EXISTS "logoUrl" TEXT;
    `);
    console.log("Clinic columns added successfully.");

  } catch (err) {
    console.error("Error updating schema:", err);
  } finally {
    await prisma.$disconnect();
  }
}
main();
