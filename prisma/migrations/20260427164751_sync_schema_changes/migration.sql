-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "brandColor" TEXT,
ADD COLUMN     "logoUrl" TEXT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Record" ADD COLUMN     "allergies" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "comorbidities" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "currentMedication" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false;
