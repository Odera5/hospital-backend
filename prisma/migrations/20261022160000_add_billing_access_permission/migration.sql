ALTER TABLE "User"
ADD COLUMN "canAccessBilling" BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE "User"
SET "canAccessBilling" = TRUE
WHERE "role" = 'billing_staff';
