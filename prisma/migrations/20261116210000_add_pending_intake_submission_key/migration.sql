ALTER TABLE "PendingIntake"
ADD COLUMN "submissionKey" TEXT;

CREATE UNIQUE INDEX "PendingIntake_submissionKey_key"
ON "PendingIntake"("submissionKey");
