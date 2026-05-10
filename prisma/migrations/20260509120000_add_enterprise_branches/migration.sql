ALTER TYPE "PlanType" ADD VALUE IF NOT EXISTS 'ENTERPRISE';

CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "area" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Branch_clinicId_slug_key" ON "Branch"("clinicId", "slug");
CREATE INDEX "Branch_clinicId_isActive_createdAt_idx" ON "Branch"("clinicId", "isActive", "createdAt");

ALTER TABLE "Branch"
ADD CONSTRAINT "Branch_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "Branch" (
    "id",
    "clinicId",
    "name",
    "slug",
    "country",
    "city",
    "area",
    "address",
    "phone",
    "isActive",
    "isPrimary",
    "createdAt",
    "updatedAt"
)
SELECT
    CONCAT('branch_', "id"),
    "id",
    "name",
    COALESCE(NULLIF(
      REGEXP_REPLACE(
        LOWER(TRIM(COALESCE("city", '') || '-' || COALESCE("name", ''))),
        '[^a-z0-9]+',
        '-',
        'g'
      ),
      ''
    ), CONCAT('branch-', "id")),
    COALESCE("country", ''),
    COALESCE("city", ''),
    '',
    COALESCE("address", ''),
    COALESCE("phone", ''),
    true,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Clinic"
WHERE NOT EXISTS (
    SELECT 1 FROM "Branch" b WHERE b."clinicId" = "Clinic"."id"
);
