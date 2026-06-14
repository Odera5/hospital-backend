-- AlterTable
ALTER TABLE "PendingIntake" ADD COLUMN IF NOT EXISTS "nextOfKinName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PendingIntake" ADD COLUMN IF NOT EXISTS "nextOfKinPhone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PendingIntake" ADD COLUMN IF NOT EXISTS "nextOfKinRelationship" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PendingIntake" ADD COLUMN IF NOT EXISTS "nextOfKinAddress" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "customRoleTitle" TEXT;

-- AlterTable
ALTER TABLE "Appointment" DROP COLUMN IF EXISTS "reminder24hSentAt";
ALTER TABLE "Appointment" DROP COLUMN IF EXISTS "reminder2hSentAt";

-- AlterTable
ALTER TABLE "Clinic" DROP COLUMN IF EXISTS "reminderTimezone";
ALTER TABLE "Clinic" DROP COLUMN IF EXISTS "reminderWindowStartHour";
ALTER TABLE "Clinic" DROP COLUMN IF EXISTS "reminderWindowEndHour";
