CREATE TABLE "PatientClinicalHistory" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reaction" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "recordedById" TEXT,
    "lastReviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientClinicalHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PatientClinicalHistory_patientId_status_category_createdAt_idx"
ON "PatientClinicalHistory"("patientId", "status", "category", "createdAt");

CREATE INDEX "PatientClinicalHistory_recordedById_idx"
ON "PatientClinicalHistory"("recordedById");

CREATE INDEX "PatientClinicalHistory_reviewedById_idx"
ON "PatientClinicalHistory"("reviewedById");

ALTER TABLE "PatientClinicalHistory"
ADD CONSTRAINT "PatientClinicalHistory_patientId_fkey"
FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PatientClinicalHistory"
ADD CONSTRAINT "PatientClinicalHistory_recordedById_fkey"
FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PatientClinicalHistory"
ADD CONSTRAINT "PatientClinicalHistory_reviewedById_fkey"
FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
