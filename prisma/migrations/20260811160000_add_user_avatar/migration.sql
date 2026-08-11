-- Adds missing avatarUrl column that is present in schema.prisma but not yet in the deployed database.
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT DEFAULT '';
