ALTER TABLE "Branch"
ADD COLUMN IF NOT EXISTS "intakeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "intakePublicToken" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Branch_intakePublicToken_key" ON "Branch"("intakePublicToken");

UPDATE "Branch" b
SET
  "intakeEnabled" = c."intakeEnabled",
  "intakePublicToken" = c."intakePublicToken"
FROM "Clinic" c
WHERE b."clinicId" = c.id
  AND b."isPrimary" = true
  AND (c."intakeEnabled" = true OR c."intakePublicToken" IS NOT NULL);
