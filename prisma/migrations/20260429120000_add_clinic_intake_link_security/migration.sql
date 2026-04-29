ALTER TABLE "Clinic"
ADD COLUMN "intakeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "intakePublicToken" TEXT;

CREATE UNIQUE INDEX "Clinic_intakePublicToken_key"
ON "Clinic"("intakePublicToken");
