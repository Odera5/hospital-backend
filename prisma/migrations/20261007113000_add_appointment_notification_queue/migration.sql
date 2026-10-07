CREATE TABLE "AppointmentNotification" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reminderOffset" INTEGER NOT NULL,
    "appointmentStart" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "lastError" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AppointmentNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppointmentNotification_dedupeKey_key"
ON "AppointmentNotification"("dedupeKey");

CREATE INDEX "AppointmentNotification_status_nextAttemptAt_idx"
ON "AppointmentNotification"("status", "nextAttemptAt");

CREATE INDEX "AppointmentNotification_appointment_offset_start_idx"
ON "AppointmentNotification"("appointmentId", "kind", "reminderOffset", "appointmentStart");

ALTER TABLE "AppointmentNotification"
ADD CONSTRAINT "AppointmentNotification_appointmentId_fkey"
FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
