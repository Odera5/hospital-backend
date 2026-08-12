-- DropIndex
DROP INDEX "Appointment_branchId_appointmentDate_idx";

-- DropIndex
DROP INDEX "Invoice_branchId_idx";

-- DropIndex
DROP INDEX "Record_branchId_idx";

-- DropIndex
DROP INDEX "WaitingRoom_branchId_status_arrivalTime_idx";

-- AlterTable
ALTER TABLE "Patient" ALTER COLUMN "dateOfBirth" DROP NOT NULL,
ALTER COLUMN "lastBirthdayGreetingYear" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PendingIntake" ALTER COLUMN "dateOfBirth" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "dateOfBirth" DROP NOT NULL;

-- CreateTable
CREATE TABLE "BillingWebhook" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "signature" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingWebhook_processed_idx" ON "BillingWebhook"("processed");
