ALTER TABLE "Patient"
ADD COLUMN "branchId" TEXT;

ALTER TABLE "PendingIntake"
ADD COLUMN "branchId" TEXT;

UPDATE "Patient" p
SET "branchId" = b."id"
FROM "Branch" b
WHERE b."clinicId" = p."clinicId"
  AND b."isPrimary" = true
  AND p."branchId" IS NULL;

UPDATE "PendingIntake" pi
SET "branchId" = b."id"
FROM "Branch" b
WHERE b."clinicId" = pi."clinicId"
  AND b."isPrimary" = true
  AND pi."branchId" IS NULL;

ALTER TABLE "Patient"
ALTER COLUMN "branchId" SET NOT NULL;

ALTER TABLE "PendingIntake"
ALTER COLUMN "branchId" SET NOT NULL;

ALTER TABLE "Patient"
ADD CONSTRAINT "Patient_branchId_fkey"
FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PendingIntake"
ADD CONSTRAINT "PendingIntake_branchId_fkey"
FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Patient_branchId_createdAt_idx" ON "Patient"("branchId", "createdAt");
CREATE INDEX "Patient_branchId_isDeleted_idx" ON "Patient"("branchId", "isDeleted");
CREATE INDEX "Patient_branchId_isDeleted_searchName_idx" ON "Patient"("branchId", "isDeleted", "searchName");
CREATE INDEX "Patient_branchId_isDeleted_searchCardNumber_idx" ON "Patient"("branchId", "isDeleted", "searchCardNumber");
CREATE INDEX "Patient_branchId_isDeleted_ageNumber_idx" ON "Patient"("branchId", "isDeleted", "ageNumber");
CREATE INDEX "PendingIntake_branchId_status_createdAt_idx" ON "PendingIntake"("branchId", "status", "createdAt");
