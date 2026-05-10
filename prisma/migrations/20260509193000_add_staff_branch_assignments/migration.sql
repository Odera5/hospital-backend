ALTER TABLE "User"
ADD COLUMN "assignedBranchIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

UPDATE "User"
SET "assignedBranchIds" = ARRAY[]::TEXT[]
WHERE "assignedBranchIds" IS NULL;

UPDATE "User" u
SET "assignedBranchIds" = ARRAY[
  COALESCE(
    (
      SELECT b."id"
      FROM "Branch" b
      WHERE b."clinicId" = u."clinicId" AND b."isActive" = TRUE
      ORDER BY b."isPrimary" DESC, b."createdAt" ASC
      LIMIT 1
    ),
    ''
  )
]
WHERE u."role" <> 'admin'
  AND COALESCE(array_length(u."assignedBranchIds", 1), 0) = 0
  AND EXISTS (
    SELECT 1
    FROM "Branch" b
    WHERE b."clinicId" = u."clinicId" AND b."isActive" = TRUE
  );

ALTER TABLE "User"
ALTER COLUMN "assignedBranchIds" SET NOT NULL;
