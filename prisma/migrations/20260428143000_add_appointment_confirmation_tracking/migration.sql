ALTER TABLE "Appointment"
ADD COLUMN "patientConfirmationStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN "patientConfirmationRespondedAt" TIMESTAMP(3),
ADD COLUMN "patientResponseToken" TEXT;

UPDATE "Appointment"
SET "patientResponseToken" = CONCAT('apt_', "id")
WHERE "patientResponseToken" IS NULL;

ALTER TABLE "Appointment"
ALTER COLUMN "patientResponseToken" SET NOT NULL;

CREATE UNIQUE INDEX "Appointment_patientResponseToken_key"
ON "Appointment"("patientResponseToken");
