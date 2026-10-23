# CareChrome MVP deployment and clinic onboarding

Use this checklist before enabling a clinic account that contains real patient information. It is an operational checklist, not a compliance certification.

## Production configuration

- Set `NODE_ENV=production`.
- Set a production `CORS_ORIGIN` containing only the exact HTTPS frontend origins.
- Set `APP_BASE_URL` or `FRONTEND_URL` to the public HTTPS frontend URL.
- Use unique, randomly generated `JWT_SECRET` and `JWT_REFRESH_SECRET` values. Do not use example or development values.
- Preserve the existing `ENCRYPTION_KEY` exactly when deploying an existing database. Patient data encrypted with a different key cannot be decrypted. Plan and test key rotation as a separate data migration.
- Configure all four R2 variables: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME`. Keep the bucket private; patient attachments are served through authorized routes and short-lived signed URLs.
- Replace the Cloudflare Turnstile test key from `.env.example` with a production secret and configure the matching frontend site key.
- Configure and test at least one supported clinic email delivery channel if email verification, appointment notifications, or reminders are part of the clinic’s workflow.
- Store all credentials in the hosting provider’s secret manager. Never commit `.env` files or include them in build artifacts.

The backend refuses to start in production if its required CORS, public app URL, R2, or Turnstile configuration is missing, or if the known Turnstile test secret is used.

## Database migrations

The API server no longer applies migrations when it starts. Apply migrations as a controlled release step from `hospital-backend`:

```powershell
npm run db:deploy
```

Before doing this for production:

1. Take a database backup and confirm it is restorable.
2. Apply every pending migration to a staging database with a recent sanitized copy of production-shaped data.
3. Verify clinic-owner backfill, existing billing data, patient access, and the new cash reconciliation follow-up fields.
4. Deploy the application only after the migration succeeds.

`prisma migrate deploy` applies **all pending migrations**, not just the newest migration. Do not use `migrate dev` or `db push` against production. Prefer a forward-fix migration over manually editing migration history or attempting an untested rollback.

## Backups and recovery

- Schedule automated PostgreSQL backups and retain them according to clinic agreements and applicable local requirements.
- Configure object-storage protection/versioning and backups for the private R2 bucket that holds clinical attachments.
- Document who can restore data and how access is approved.
- Before onboarding, restore a database backup and representative attachments into an isolated environment and verify the application can read them.
- Repeat restore tests periodically and after material storage or database changes. A backup without a successful restore test is not a verified recovery plan.

## Patient data and runtime files

- The backend `uploads/` directory is ignored by Git because it may contain runtime files. Git ignore does not remove files already tracked or erase repository history. Verify the release artifact and repository history before publishing; if real patient files were committed, treat that as a privacy incident and follow the clinic’s response process.
- New clinical attachments use private object storage. Do not make the R2 bucket public or expose its credentials to the browser.
- Patient demographics are only partially encrypted by the current application. Keep database encryption at rest enabled and restrict database access to the backend service.
- Do not count `src/middleware/fileEncryptor.js` as active protection; it is not wired into the attachment flow.
- The Trash screen tells users that trashed patients are automatically permanently deleted after six months. Explain this retention behavior during onboarding and verify it aligns with each clinic’s retention policy before enabling automatic cleanup.

## MVP runtime topology

- Start with one backend application instance. The server currently starts reminder, birthday, patient-index, and Trash-cleanup jobs in-process; running multiple uncoordinated instances may duplicate some work.
- Do not scale backend replicas until background jobs have a single-worker deployment or reliable distributed coordination.
- Configure HTTPS, health/readiness monitoring (`/health` and `/ready`), log retention/access controls, and an alert path for database or object-storage failures.
- Review error logs for patient information before forwarding logs to third-party monitoring services.

## Pre-onboarding smoke test

In staging, use synthetic patient data to verify:

1. Clinic registration, email verification, login, role changes, and branch restrictions.
2. Patient creation, chart updates, consent edits, attachment upload, and authorized attachment retrieval.
3. Appointment creation, patient responses, reminder delivery, and waiting-room workflow.
4. Invoice creation, cash/card/bank payment, reversal, cash close, independent review, flagged investigation, and resolution.
5. Audit-log entries for patient, permission, billing, and cash-close actions.
6. Subscription-expiration behavior and clinic access recovery after renewal.
7. A database-and-attachment restore in an isolated environment.

Only move to clinic data after the smoke test passes and the clinic understands support contacts, retention, backup/recovery expectations, and any features that are not yet included.
