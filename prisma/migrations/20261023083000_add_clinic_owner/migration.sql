ALTER TABLE "User"
ADD COLUMN "isClinicOwner" BOOLEAN NOT NULL DEFAULT FALSE;

WITH clinic_admins AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "clinicId"
      ORDER BY "createdAt" ASC, id ASC
    ) AS admin_rank
  FROM "User"
  WHERE role = 'admin'
)
UPDATE "User" AS users
SET "isClinicOwner" = TRUE
FROM clinic_admins
WHERE users.id = clinic_admins.id
  AND clinic_admins.admin_rank = 1;

CREATE UNIQUE INDEX "User_one_clinic_owner_per_clinic_key"
ON "User"("clinicId")
WHERE "isClinicOwner" = TRUE;
