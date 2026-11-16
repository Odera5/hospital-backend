CREATE TABLE "SubscriptionHistory" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "actorId" TEXT,
    "fromPlan" "PlanType" NOT NULL,
    "toPlan" "PlanType" NOT NULL,
    "fromInterval" TEXT NOT NULL,
    "toInterval" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "prorationCredit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paystackReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubscriptionHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SubscriptionHistory_clinicId_idx"
ON "SubscriptionHistory"("clinicId");

ALTER TABLE "SubscriptionHistory"
ADD CONSTRAINT "SubscriptionHistory_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
