CREATE TABLE "BillingPayment" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "paymentMethod" TEXT NOT NULL,
  "reference" TEXT NOT NULL DEFAULT '',
  "notes" TEXT NOT NULL DEFAULT '',
  "receiptNumber" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'recorded',
  "reversalOfId" TEXT,
  "reversalReason" TEXT NOT NULL DEFAULT '',
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedById" TEXT,
  "reversedById" TEXT,
  CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CashReconciliation" (
  "id" TEXT NOT NULL,
  "clinicId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "businessDate" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "expectedCash" DOUBLE PRECISION NOT NULL,
  "countedCash" DOUBLE PRECISION NOT NULL,
  "variance" DOUBLE PRECISION NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "notes" TEXT NOT NULL DEFAULT '',
  "reviewerNotes" TEXT NOT NULL DEFAULT '',
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  CONSTRAINT "CashReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingPayment_receiptNumber_key" ON "BillingPayment"("receiptNumber");
CREATE UNIQUE INDEX "BillingPayment_reversalOfId_key" ON "BillingPayment"("reversalOfId");
CREATE INDEX "BillingPayment_invoiceId_recordedAt_idx" ON "BillingPayment"("invoiceId", "recordedAt");
CREATE INDEX "BillingPayment_branchId_recordedAt_idx" ON "BillingPayment"("branchId", "recordedAt");
CREATE INDEX "BillingPayment_recordedById_recordedAt_idx" ON "BillingPayment"("recordedById", "recordedAt");

CREATE UNIQUE INDEX "CashReconciliation_branchId_businessDate_key" ON "CashReconciliation"("branchId", "businessDate");
CREATE INDEX "CashReconciliation_clinicId_businessDate_idx" ON "CashReconciliation"("clinicId", "businessDate");
CREATE INDEX "CashReconciliation_branchId_status_businessDate_idx" ON "CashReconciliation"("branchId", "status", "businessDate");

ALTER TABLE "BillingPayment"
  ADD CONSTRAINT "BillingPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BillingPayment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BillingPayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "BillingPayment_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "BillingPayment_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "BillingPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CashReconciliation"
  ADD CONSTRAINT "CashReconciliation_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CashReconciliation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CashReconciliation_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "CashReconciliation_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "BillingPayment" (
  "id",
  "invoiceId",
  "branchId",
  "amount",
  "paymentMethod",
  "reference",
  "notes",
  "receiptNumber",
  "recordedAt"
)
SELECT
  COALESCE(NULLIF(payment.value->>'id', ''), 'legacy-' || md5(invoice.id || ':' || payment.ordinality::text)),
  invoice.id,
  COALESCE(invoice."branchId", patient."branchId"),
  (payment.value->>'amount')::DOUBLE PRECISION,
  COALESCE(NULLIF(payment.value->>'paymentMethod', ''), 'cash'),
  COALESCE(payment.value->>'reference', ''),
  COALESCE(payment.value->>'notes', ''),
  'LEGACY-' || invoice.id || '-' || payment.ordinality::text,
  COALESCE(NULLIF(payment.value->>'receivedAt', '')::TIMESTAMPTZ::TIMESTAMP, invoice."createdAt")
FROM "Invoice" AS invoice
JOIN "Patient" AS patient ON patient.id = invoice."patientId"
CROSS JOIN LATERAL jsonb_array_elements(invoice.payments::jsonb) WITH ORDINALITY AS payment(value, ordinality)
WHERE jsonb_typeof(invoice.payments::jsonb) = 'array'
  AND COALESCE((payment.value->>'amount')::DOUBLE PRECISION, 0) > 0
ON CONFLICT ("receiptNumber") DO NOTHING;
