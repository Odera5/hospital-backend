CREATE INDEX "Clinic_isActive_plan_subscriptionEnds_idx"
ON "Clinic"("isActive", "plan", "subscriptionEnds");

CREATE TABLE "TrialFollowUpNotification" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "subscriptionEnd" TIMESTAMP(3) NOT NULL,
    "milestone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrialFollowUpNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrialFollowUpNotification_clinicId_subscriptionEnd_milestone_key"
ON "TrialFollowUpNotification"("clinicId", "subscriptionEnd", "milestone");

CREATE INDEX "TrialFollowUpNotification_status_lockedUntil_idx"
ON "TrialFollowUpNotification"("status", "lockedUntil");

ALTER TABLE "TrialFollowUpNotification"
ADD CONSTRAINT "TrialFollowUpNotification_clinicId_fkey"
FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
