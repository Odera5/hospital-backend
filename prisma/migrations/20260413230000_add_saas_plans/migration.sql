-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('FREE', 'PRO');

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN "plan" "PlanType" NOT NULL DEFAULT 'FREE';
ALTER TABLE "Clinic" ADD COLUMN "stripeCustomerId" TEXT;
ALTER TABLE "Clinic" ADD COLUMN "subscriptionEnds" TIMESTAMP(3);
