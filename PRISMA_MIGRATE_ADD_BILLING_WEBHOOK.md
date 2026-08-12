Run this locally to create the `BillingWebhook` table after pulling the changes to `schema.prisma`.

1. From the `backend` directory, generate and apply a migration:

```bash
npx prisma migrate dev --name add_billing_webhook
```

2. If you only want to create SQL and review it first:

```bash
npx prisma migrate dev --create-only --name add_billing_webhook
```

3. After migration, run the worker once to process any backlog:

```bash
npm run jobs:process-webhooks
```

Notes:

- Ensure `DATABASE_URL` is set in your environment before running migrations.
- The migration will add the `BillingWebhook` model and columns `attempts` and `lastError` for retry tracking.
