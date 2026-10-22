UPDATE "AuditLog" AS audit_log
SET "branchId" = patient."branchId"
FROM "Patient" AS patient
WHERE audit_log."patientId" = patient.id
  AND audit_log."branchId" IS NULL
  AND audit_log."resourceType" = 'patient'
  AND audit_log."action" = 'patient.create';
