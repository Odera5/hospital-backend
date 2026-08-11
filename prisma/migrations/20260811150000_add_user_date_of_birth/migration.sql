-- Adds missing columns that are present in schema.prisma but not yet in the deployed database.
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "dateOfBirth" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Patient"
ADD COLUMN IF NOT EXISTS "dateOfBirth" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Patient"
ADD COLUMN IF NOT EXISTS "lastBirthdayGreetingYear" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PendingIntake"
ADD COLUMN IF NOT EXISTS "dateOfBirth" TEXT NOT NULL DEFAULT '';
