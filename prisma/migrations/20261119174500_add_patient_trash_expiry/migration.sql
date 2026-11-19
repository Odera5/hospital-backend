ALTER TABLE "Patient"
ADD COLUMN "deletedAt" TIMESTAMP(3);

UPDATE "Patient"
SET "deletedAt" = "updatedAt"
WHERE "isDeleted" = true
  AND "deletedAt" IS NULL;

CREATE INDEX "Patient_isDeleted_deletedAt_idx"
ON "Patient"("isDeleted", "deletedAt");
