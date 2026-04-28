ALTER TABLE "Appointment"
ADD COLUMN "reminderEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "reminderStatus" TEXT NOT NULL DEFAULT 'disabled',
ADD COLUMN "reminder24hSentAt" TIMESTAMP(3),
ADD COLUMN "reminder2hSentAt" TIMESTAMP(3),
ADD COLUMN "reminderLastSentAt" TIMESTAMP(3),
ADD COLUMN "reminderLastError" TEXT NOT NULL DEFAULT '';

CREATE INDEX "Appointment_reminderEnabled_status_appointmentDate_idx"
ON "Appointment"("reminderEnabled", "status", "appointmentDate");
