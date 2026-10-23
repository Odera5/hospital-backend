ALTER TABLE "CashReconciliation"
  ADD COLUMN "followUpNotes" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "respondedAt" TIMESTAMP(3),
  ADD COLUMN "respondedById" TEXT,
  ADD COLUMN "resolutionNotes" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedById" TEXT;

ALTER TABLE "CashReconciliation"
  ADD CONSTRAINT "CashReconciliation_respondedById_fkey"
    FOREIGN KEY ("respondedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CashReconciliation_resolvedById_fkey"
    FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
