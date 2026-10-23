WITH history AS (
    SELECT
        "patientId",
        'allergy'::TEXT AS category,
        BTRIM(allergies) AS value,
        "createdAt"
    FROM "Record"
    WHERE "isDeleted" = false
      AND BTRIM(allergies) <> ''
      AND LOWER(BTRIM(allergies)) NOT LIKE 'no known%'
      AND LOWER(BTRIM(allergies)) NOT LIKE 'none%'
      AND LOWER(BTRIM(allergies)) NOT IN ('nil', 'nka')
    UNION ALL
    SELECT
        "patientId",
        'comorbidity'::TEXT AS category,
        BTRIM(comorbidities) AS value,
        "createdAt"
    FROM "Record"
    WHERE "isDeleted" = false
      AND BTRIM(comorbidities) <> ''
      AND LOWER(BTRIM(comorbidities)) NOT LIKE 'no known%'
      AND LOWER(BTRIM(comorbidities)) NOT LIKE 'none%'
      AND LOWER(BTRIM(comorbidities)) NOT IN ('nil', 'nka')
),
deduplicated AS (
    SELECT DISTINCT ON ("patientId", category, LOWER(value))
        "patientId",
        category,
        value,
        "createdAt"
    FROM history
    ORDER BY "patientId", category, LOWER(value), "createdAt" ASC
)
INSERT INTO "PatientClinicalHistory" (
    "id",
    "patientId",
    category,
    value,
    status,
    "createdAt",
    "updatedAt"
)
SELECT
    'history_' || MD5(source."patientId" || ':' || source.category || ':' || LOWER(source.value)),
    source."patientId",
    source.category,
    source.value,
    'active',
    source."createdAt",
    source."createdAt"
FROM deduplicated AS source
WHERE NOT EXISTS (
    SELECT 1
    FROM "PatientClinicalHistory" AS existing
    WHERE existing."patientId" = source."patientId"
      AND existing.category = source.category
      AND LOWER(existing.value) = LOWER(source.value)
);

WITH ranked AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "patientId", category, LOWER(value)
            ORDER BY "createdAt" ASC, "id" ASC
        ) AS row_number
    FROM "PatientClinicalHistory"
)
DELETE FROM "PatientClinicalHistory"
WHERE "id" IN (SELECT "id" FROM ranked WHERE row_number > 1);

DROP INDEX "PatientClinicalHistory_patientId_status_category_createdAt_idx";
DROP INDEX "PatientClinicalHistory_recordedById_idx";
DROP INDEX "PatientClinicalHistory_reviewedById_idx";

ALTER TABLE "PatientClinicalHistory"
DROP CONSTRAINT "PatientClinicalHistory_recordedById_fkey",
DROP CONSTRAINT "PatientClinicalHistory_reviewedById_fkey",
DROP COLUMN "reaction",
DROP COLUMN "status",
DROP COLUMN "recordedById",
DROP COLUMN "lastReviewedAt",
DROP COLUMN "reviewedById",
DROP COLUMN "updatedAt";

CREATE UNIQUE INDEX "PatientClinicalHistory_patientId_category_value_key"
ON "PatientClinicalHistory"("patientId", "category", "value");

CREATE INDEX "PatientClinicalHistory_patientId_category_createdAt_idx"
ON "PatientClinicalHistory"("patientId", "category", "createdAt");
