-- Remove fields used only by the retired Stripe billing integration.
ALTER TABLE "Clinic"
DROP COLUMN IF EXISTS "stripeCustomerId",
DROP COLUMN IF EXISTS "stripeSubscriptionId",
DROP COLUMN IF EXISTS "stripeSubscriptionStatus",
DROP COLUMN IF EXISTS "stripePriceId",
DROP COLUMN IF EXISTS "stripeNextPaymentDate";
