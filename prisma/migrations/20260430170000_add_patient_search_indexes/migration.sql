ALTER TABLE "Patient"
ADD COLUMN IF NOT EXISTS "searchName" TEXT,
ADD COLUMN IF NOT EXISTS "searchCardNumber" TEXT,
ADD COLUMN IF NOT EXISTS "ageNumber" INTEGER;

CREATE INDEX IF NOT EXISTS "Patient_clinicId_isDeleted_searchName_idx"
ON "Patient"("clinicId", "isDeleted", "searchName");

CREATE INDEX IF NOT EXISTS "Patient_clinicId_isDeleted_searchCardNumber_idx"
ON "Patient"("clinicId", "isDeleted", "searchCardNumber");

CREATE INDEX IF NOT EXISTS "Patient_clinicId_isDeleted_ageNumber_idx"
ON "Patient"("clinicId", "isDeleted", "ageNumber");
