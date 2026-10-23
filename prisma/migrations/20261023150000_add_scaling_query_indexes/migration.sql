CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Patient_searchName_trgm_idx"
  ON "Patient" USING GIN ("searchName" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Patient_searchCardNumber_trgm_idx"
  ON "Patient" USING GIN ("searchCardNumber" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Patient_phone_trgm_idx"
  ON "Patient" USING GIN ("phone" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Patient_search_backfill_idx"
  ON "Patient" ("clinicId", "id")
  WHERE "searchName" IS NULL
     OR "searchCardNumber" IS NULL
     OR "ageNumber" IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Patient_clinicId_branchId_isDeleted_createdAt_id_idx"
  ON "Patient" ("clinicId", "branchId", "isDeleted", "createdAt", "id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Appointment_branchId_appointmentDate_status_idx"
  ON "Appointment" ("branchId", "appointmentDate", "status");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Invoice_branchId_invoiceDate_idx"
  ON "Invoice" ("branchId", "invoiceDate");
