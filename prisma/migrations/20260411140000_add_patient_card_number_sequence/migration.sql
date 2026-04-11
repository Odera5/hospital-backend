ALTER TABLE "Patient"
ADD COLUMN "cardNumberSequence" INTEGER;

CREATE UNIQUE INDEX "Patient_clinicId_cardNumberSequence_key"
ON "Patient"("clinicId", "cardNumberSequence");
