ALTER TABLE "AuditLog"
ADD COLUMN "branchId" TEXT;

CREATE INDEX "AuditLog_branchId_createdAt_idx"
ON "AuditLog"("branchId", "createdAt");

ALTER TABLE "AuditLog"
ADD CONSTRAINT "AuditLog_branchId_fkey"
FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
