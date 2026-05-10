ALTER TABLE "Clinic"
ADD COLUMN IF NOT EXISTS "reminderOffsets" INTEGER[] NOT NULL DEFAULT ARRAY[1440, 120];

ALTER TABLE "Record"
ADD COLUMN IF NOT EXISTS "vitals" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN IF NOT EXISTS "branchId" TEXT;

ALTER TABLE "Appointment"
ADD COLUMN IF NOT EXISTS "branchId" TEXT;

ALTER TABLE "WaitingRoom"
ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'normal',
ADD COLUMN IF NOT EXISTS "branchId" TEXT;

ALTER TABLE "Invoice"
ADD COLUMN IF NOT EXISTS "branchId" TEXT;

CREATE INDEX IF NOT EXISTS "Record_branchId_idx"
ON "Record"("branchId");

CREATE INDEX IF NOT EXISTS "Appointment_branchId_appointmentDate_idx"
ON "Appointment"("branchId", "appointmentDate");

CREATE INDEX IF NOT EXISTS "WaitingRoom_branchId_status_arrivalTime_idx"
ON "WaitingRoom"("branchId", "status", "arrivalTime");

CREATE INDEX IF NOT EXISTS "Invoice_branchId_idx"
ON "Invoice"("branchId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Record_branchId_fkey'
  ) THEN
    ALTER TABLE "Record"
    ADD CONSTRAINT "Record_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Appointment_branchId_fkey'
  ) THEN
    ALTER TABLE "Appointment"
    ADD CONSTRAINT "Appointment_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'WaitingRoom_branchId_fkey'
  ) THEN
    ALTER TABLE "WaitingRoom"
    ADD CONSTRAINT "WaitingRoom_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Invoice_branchId_fkey'
  ) THEN
    ALTER TABLE "Invoice"
    ADD CONSTRAINT "Invoice_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
