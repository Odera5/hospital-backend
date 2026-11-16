ALTER TABLE "BillingWebhook"
ADD COLUMN "adminAlertAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "adminAlertLastError" TEXT,
ADD COLUMN "adminAlertLockedUntil" TIMESTAMP(3),
ADD COLUMN "adminAlertSentAt" TIMESTAMP(3);
