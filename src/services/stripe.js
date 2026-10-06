import Stripe from "stripe";
import { prisma } from "../lib/prisma.js";

const DEFAULT_PRO_USD_MONTHLY = 6900; // $69 in cents
const DEFAULT_PRO_USD_ANNUAL = 69000; // $690 in cents
const DEFAULT_ENTERPRISE_USD_MONTHLY = 12900; // $129 in cents
const DEFAULT_ENTERPRISE_USD_ANNUAL = 129000; // $1,290 in cents

const resolveBaseUrl = () =>
  process.env.APP_BASE_URL?.trim() ||
  process.env.FRONTEND_URL?.trim() ||
  process.env.CORS_ORIGIN?.split(",")[0]?.trim() ||
  "http://localhost:5173";

export const getStripeClient = () => {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    const error = new Error("Stripe is not configured. Set STRIPE_SECRET_KEY before processing Stripe payments.");
    error.statusCode = 500;
    throw error;
  }
  return new Stripe(secretKey);
};

export const getStripePlanConfig = (planType = "PRO", interval = "monthly") => {
  const isEnterprise = String(planType).toUpperCase() === "ENTERPRISE";
  const isAnnual = String(interval).toLowerCase() === "annually";

  if (isEnterprise) {
    return {
      planType: "ENTERPRISE",
      name: `CareChrome Enterprise ${isAnnual ? "Annual" : "Monthly"}`,
      description: "CareChrome Enterprise subscription for multi-branch clinic operations",
      amountCents: isAnnual
        ? Number(process.env.STRIPE_ENTERPRISE_ANNUAL_CENTS) || DEFAULT_ENTERPRISE_USD_ANNUAL
        : Number(process.env.STRIPE_ENTERPRISE_MONTHLY_CENTS) || DEFAULT_ENTERPRISE_USD_MONTHLY,
      interval: isAnnual ? "year" : "month",
      envPriceId: isAnnual
        ? process.env.STRIPE_ENTERPRISE_ANNUAL_PRICE_ID?.trim()
        : process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID?.trim(),
    };
  }

  return {
    planType: "PRO",
    name: `CareChrome Professional ${isAnnual ? "Annual" : "Monthly"}`,
    description: "CareChrome Professional subscription for clinics",
    amountCents: isAnnual
      ? Number(process.env.STRIPE_PRO_ANNUAL_CENTS) || DEFAULT_PRO_USD_ANNUAL
      : Number(process.env.STRIPE_PRO_MONTHLY_CENTS) || DEFAULT_PRO_USD_MONTHLY,
    interval: isAnnual ? "year" : "month",
    envPriceId: isAnnual
      ? process.env.STRIPE_PRO_ANNUAL_PRICE_ID?.trim()
      : process.env.STRIPE_PRO_MONTHLY_PRICE_ID?.trim(),
  };
};

export async function getOrCreateStripeCustomer(clinic) {
  const stripe = getStripeClient();

  if (clinic.stripeCustomerId) {
    try {
      const existing = await stripe.customers.retrieve(clinic.stripeCustomerId);
      if (!existing.deleted) {
        return existing.id;
      }
    } catch (e) {
      console.warn("Could not retrieve existing Stripe customer, creating new one:", e.message);
    }
  }

  const customer = await stripe.customers.create({
    email: clinic.email,
    name: clinic.name,
    metadata: {
      clinicId: clinic.id,
    },
  });

  await prisma.clinic.update({
    where: { id: clinic.id },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

export async function createStripeCheckoutSession({ clinic, plan = "PRO", interval = "monthly" }) {
  const stripe = getStripeClient();
  const customerId = await getOrCreateStripeCustomer(clinic);
  const planConfig = getStripePlanConfig(plan, interval);
  const baseUrl = resolveBaseUrl();

  const lineItems = planConfig.envPriceId
    ? [{ price: planConfig.envPriceId, quantity: 1 }]
    : [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: planConfig.name,
              description: planConfig.description,
            },
            unit_amount: planConfig.amountCents,
            recurring: {
              interval: planConfig.interval,
            },
          },
          quantity: 1,
        },
      ];

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    payment_method_types: ["card"],
    line_items: lineItems,
    metadata: {
      clinicId: clinic.id,
      plan: planConfig.planType,
      interval,
    },
    subscription_data: {
      metadata: {
        clinicId: clinic.id,
        plan: planConfig.planType,
        interval,
      },
    },
    success_url: `${baseUrl}/upgrade?stripe_status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/upgrade?stripe_status=cancelled`,
  });

  return {
    sessionId: session.id,
    checkoutUrl: session.url,
  };
}

export async function createStripePortalSession({ clinic, returnUrl }) {
  const stripe = getStripeClient();
  const customerId = await getOrCreateStripeCustomer(clinic);
  const baseUrl = resolveBaseUrl();

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl || `${baseUrl}/upgrade`,
  });

  return { url: session.url };
}

export async function verifyStripeCheckoutSession(sessionId) {
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  if (session.payment_status === "paid" || session.status === "complete") {
    const clinicId = session.metadata?.clinicId;
    const plan = session.metadata?.plan || "PRO";

    if (clinicId && session.subscription) {
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
      const now = new Date();
      let periodEnd = new Date(subscription.current_period_end * 1000);

      if (clinic?.subscriptionEnds && new Date(clinic.subscriptionEnds) > now) {
        const remainingDaysMs = new Date(clinic.subscriptionEnds).getTime() - now.getTime();
        periodEnd = new Date(periodEnd.getTime() + remainingDaysMs);
      }

      const updatedClinic = await prisma.clinic.update({
        where: { id: clinicId },
        data: {
          plan,
          stripeCustomerId: typeof session.customer === "string" ? session.customer : session.customer?.id,
          stripeSubscriptionId: session.subscription,
          stripeSubscriptionStatus: "active",
          stripeNextPaymentDate: new Date(subscription.current_period_end * 1000),
          subscriptionEnds: periodEnd,
        },
      });

      return {
        success: true,
        clinic: updatedClinic,
        session,
      };
    }
  }

  return {
    success: false,
    session,
  };
}

export async function cancelStripeSubscription({ clinic }) {
  const stripe = getStripeClient();

  if (!clinic.stripeSubscriptionId) {
    const error = new Error("No active Stripe subscription found for this clinic.");
    error.statusCode = 400;
    throw error;
  }

  const subscription = await stripe.subscriptions.update(clinic.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });

  const updatedClinic = await prisma.clinic.update({
    where: { id: clinic.id },
    data: {
      stripeSubscriptionStatus: "non-renewing",
    },
  });

  return {
    subscription,
    clinic: updatedClinic,
    message: "Stripe auto-renewal has been canceled. Your clinic access remains active until the end of your current billing period.",
  };
}

export async function handleStripeWebhookEvent({ rawBody, signature }) {
  const stripe = getStripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();

  let event;
  if (webhookSecret) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      console.error("Stripe webhook signature verification failed:", err.message);
      const error = new Error(`Stripe webhook signature error: ${err.message}`);
      error.statusCode = 400;
      throw error;
    }
  } else {
    console.warn("⚠️ STRIPE_WEBHOOK_SECRET is not configured! Parsing webhook without signature verification.");
    event = JSON.parse(rawBody.toString("utf8"));
  }

  console.log(`[Stripe Webhook] Received event: ${event.type}`);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const clinicId = session.metadata?.clinicId;
      const plan = session.metadata?.plan || "PRO";

      if (clinicId && session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
        const now = new Date();
        let periodEnd = new Date(subscription.current_period_end * 1000);

        if (clinic?.subscriptionEnds && new Date(clinic.subscriptionEnds) > now) {
          const remainingDaysMs = new Date(clinic.subscriptionEnds).getTime() - now.getTime();
          periodEnd = new Date(periodEnd.getTime() + remainingDaysMs);
        }

        await prisma.clinic.update({
          where: { id: clinicId },
          data: {
            plan,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            stripeSubscriptionStatus: "active",
            stripeNextPaymentDate: new Date(subscription.current_period_end * 1000),
            subscriptionEnds: periodEnd,
          },
        });

        console.log(`[Stripe Webhook] Clinic ${clinicId} activated on plan ${plan} until ${periodEnd.toISOString()}`);
      }
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;

      if (customerId && subscriptionId) {
        const clinic = await prisma.clinic.findFirst({
          where: { stripeCustomerId: customerId },
        });

        if (clinic) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const periodEnd = new Date(subscription.current_period_end * 1000);

          await prisma.clinic.update({
            where: { id: clinic.id },
            data: {
              stripeSubscriptionId: subscriptionId,
              stripeSubscriptionStatus: "active",
              stripeNextPaymentDate: periodEnd,
              subscriptionEnds: periodEnd,
            },
          });

          console.log(`[Stripe Webhook] Invoice payment succeeded for clinic ${clinic.id}. Renewed to ${periodEnd.toISOString()}`);
        }
      }
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const clinic = await prisma.clinic.findFirst({
        where: { stripeCustomerId: customerId },
      });

      if (clinic) {
        const periodEnd = new Date(subscription.current_period_end * 1000);
        const status = subscription.cancel_at_period_end ? "non-renewing" : subscription.status;

        await prisma.clinic.update({
          where: { id: clinic.id },
          data: {
            stripeSubscriptionId: subscription.id,
            stripeSubscriptionStatus: status,
            stripeNextPaymentDate: periodEnd,
            subscriptionEnds: periodEnd,
          },
        });

        console.log(`[Stripe Webhook] Subscription updated for clinic ${clinic.id}: status=${status}`);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const clinic = await prisma.clinic.findFirst({
        where: { stripeCustomerId: customerId },
      });

      if (clinic) {
        await prisma.clinic.update({
          where: { id: clinic.id },
          data: {
            stripeSubscriptionStatus: "canceled",
          },
        });

        console.log(`[Stripe Webhook] Subscription deleted for clinic ${clinic.id}`);
      }
      break;
    }

    default:
      console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
  }

  return { received: true };
}
