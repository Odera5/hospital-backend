ALTER TABLE "Appointment"
ADD COLUMN "remindersSent" JSONB NOT NULL DEFAULT '[]';
