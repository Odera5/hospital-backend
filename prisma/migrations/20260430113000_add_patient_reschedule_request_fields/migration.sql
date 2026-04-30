ALTER TABLE "Appointment"
ADD COLUMN "patientRequestedRescheduleDate" TIMESTAMP(3),
ADD COLUMN "patientRequestedRescheduleTime" TEXT,
ADD COLUMN "patientRequestedRescheduleNote" TEXT NOT NULL DEFAULT '',
ADD COLUMN "patientRequestedRescheduleAt" TIMESTAMP(3);
