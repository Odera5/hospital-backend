CREATE TABLE "Clinic" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "contactPerson" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Clinic_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Clinic_email_key" ON "Clinic"("email");

INSERT INTO "Clinic" ("id", "name", "email", "phone", "address", "contactPerson")
VALUES ('legacy_clinic', 'Mimi Dental Clinic', 'legacy@bhf.local', '', '', 'Mimi Dental Clinic')
ON CONFLICT ("email") DO NOTHING;

ALTER TABLE "User" ADD COLUMN "clinicId" TEXT;
ALTER TABLE "Patient" ADD COLUMN "clinicId" TEXT;

UPDATE "User"
SET "clinicId" = 'legacy_clinic'
WHERE "clinicId" IS NULL;

UPDATE "Patient"
SET "clinicId" = 'legacy_clinic'
WHERE "clinicId" IS NULL;

ALTER TABLE "User" ALTER COLUMN "clinicId" SET NOT NULL;
ALTER TABLE "Patient" ALTER COLUMN "clinicId" SET NOT NULL;

CREATE INDEX "User_clinicId_role_idx" ON "User"("clinicId", "role");
CREATE INDEX "Patient_clinicId_createdAt_idx" ON "Patient"("clinicId", "createdAt");
CREATE INDEX "Patient_clinicId_isDeleted_idx" ON "Patient"("clinicId", "isDeleted");

ALTER TABLE "User"
ADD CONSTRAINT "User_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Patient"
ADD CONSTRAINT "Patient_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
