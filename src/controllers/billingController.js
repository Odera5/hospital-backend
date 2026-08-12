import { prisma } from "../lib/prisma.js";
import crypto from "crypto";
import { logAuditEvent } from "../services/auditLog.js";
import {
  disablePaystackSubscription,
  enablePaystackSubscription,
  isInactivePaystackSubscriptionError,
  recoverClinicPaystackSubscription,
  generatePaystackManageLink,
  initializePaystackSubscription,
  initializeOneOffCharge,
  getPlanConfig,
  computeSubscriptionEndDate,
  parseRequestedBillingInterval,
  parseRequestedPlanType,
  processPaystackWebhookEvent,
  serializeBillingClinic,
  verifyPaystackSignature,
  verifyPaystackTransaction,
} from "../services/paystack.js";

const buildPaystackVerificationResponse = ({
  clinic,
  transaction,
  message,
}) => ({
  message: message || "Paystack subscription activated successfully",
  clinic: clinic ? serializeBillingClinic(clinic) : null,
  transaction: {
    reference: transaction.reference,
    status: transaction.status,
    paidAt: transaction.paid_at || transaction.paidAt || null,
  },
});

const FINAL_PAYSTACK_SUBSCRIPTION_STATUSES = new Set([
  "cancelled",
  "canceled",
  "completed",
]);

const getNormalizedSubscriptionStatus = (clinic) =>
  String(clinic?.paystackSubscriptionStatus || "").toLowerCase();

const isFinalPaystackSubscriptionStatus = (clinic) =>
  FINAL_PAYSTACK_SUBSCRIPTION_STATUSES.has(
    getNormalizedSubscriptionStatus(clinic),
  );

const cannotResumeSubscriptionMessage =
  "This Paystack subscription has already been cancelled and cannot be resumed. Start a new checkout to renew your plan.";

const isCannotReactivatePaystackSubscriptionError = (error) => {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("subscription") &&
    (message.includes("cannot be reactivated") ||
      message.includes("can not be reactivated") ||
      message.includes("cancelled"))
  );
};
const getSubscriptionAuditScope = () => ({
  actionPrefix: "upgrade_plan",
  resourceType: "upgrade_plan",
});

export const getBillingOverview = async (req, res) => {
  try {
    let clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    clinic = await recoverClinicPaystackSubscription(clinic, {
      forceRefresh: true,
    });

    return res.json({ clinic: serializeBillingClinic(clinic) });
  } catch (error) {
    console.error("Get billing overview error:", error);
    return res.status(500).json({ message: "Failed to load billing details" });
  }
};

export const initializePaystackCheckout = async (req, res) => {
  try {
    const interval = parseRequestedBillingInterval(req.body?.interval);
    const planType = parseRequestedPlanType(req.body?.plan);

    const clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    const checkout = await initializePaystackSubscription({
      clinic,
      actor: req.user,
      interval,
      planType,
    });

    return res.status(201).json(checkout);
  } catch (error) {
    console.error("Initialize Paystack checkout error:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to initialize Paystack checkout",
    });
  }
};

export const getPaystackManageLink = async (req, res) => {
  try {
    const clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    if (!clinic.paystackSubscriptionCode) {
      return res.status(400).json({
        message:
          "This clinic does not have an active Paystack subscription yet.",
      });
    }

    const link = await generatePaystackManageLink(
      clinic.paystackSubscriptionCode,
    );

    return res.json({ link });
  } catch (error) {
    console.error("Get Paystack manage link error:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to generate Paystack management link",
    });
  }
};

export const verifyPaystackCheckout = async (req, res) => {
  try {
    const reference = String(
      req.query?.reference || req.body?.reference || "",
    ).trim();

    if (!reference) {
      return res.status(400).json({ message: "Missing transaction reference" });
    }

    const { transaction, clinic } = await verifyPaystackTransaction(reference);

    return res.json(
      buildPaystackVerificationResponse({
        clinic,
        transaction,
      }),
    );
  } catch (error) {
    console.error("Verify Paystack checkout error:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to verify Paystack payment",
    });
  }
};

export const verifyPaystackCheckoutPublic = async (req, res) => {
  try {
    const reference = String(
      req.query?.reference || req.body?.reference || "",
    ).trim();

    if (!reference) {
      return res.status(400).json({ message: "Missing transaction reference" });
    }

    const { transaction, clinic } = await verifyPaystackTransaction(reference);

    return res.json(
      buildPaystackVerificationResponse({
        clinic,
        transaction,
      }),
    );
  } catch (error) {
    console.error("Public verify Paystack checkout error:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to verify Paystack payment",
    });
  }
};

export const upgradeSubscription = async (req, res) => {
  try {
    const requestedPlan = parseRequestedPlanType(req.body?.plan);
    const requestedInterval = parseRequestedBillingInterval(req.body?.interval);

    const clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
    });
    if (!clinic) return res.status(404).json({ message: "Clinic not found" });

    const now = new Date();
    const targetConfig = getPlanConfig(requestedPlan, requestedInterval);
    const currentConfig = getPlanConfig(clinic.plan || "PRO", "monthly");

    // compute proration credit for remaining time on current subscription (approximate)
    let prorationCredit = 0;
    if (clinic.subscriptionEnds && new Date(clinic.subscriptionEnds) > now) {
      const remainingMs =
        new Date(clinic.subscriptionEnds).getTime() - now.getTime();
      const periodMs =
        requestedInterval === "annually"
          ? 365 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000;
      const fraction = Math.max(0, Math.min(1, remainingMs / periodMs));
      prorationCredit = Math.round((currentConfig.amount || 0) * fraction);
    }

    const amountDueKobo = Math.max(
      0,
      (targetConfig.amount || 0) - prorationCredit,
    );

    // create subscription history record
    const history = await prisma.subscriptionHistory.create({
      data: {
        clinicId: clinic.id,
        actorId: req.user.id,
        fromPlan: clinic.plan || "PRO",
        toPlan: requestedPlan,
        fromInterval: "monthly",
        toInterval: requestedInterval,
        amount: (targetConfig.amount || 0) / 100,
        prorationCredit: (prorationCredit || 0) / 100,
        status: amountDueKobo === 0 ? "completed" : "pending",
      },
    });

    if (amountDueKobo === 0) {
      // immediately apply change
      const newSubscriptionEnds = computeSubscriptionEndDate({
        paidAt: now.toISOString(),
        interval: requestedInterval,
      });
      const updatedClinic = await prisma.clinic.update({
        where: { id: clinic.id },
        data: { plan: requestedPlan, subscriptionEnds: newSubscriptionEnds },
      });
      await prisma.subscriptionHistory.update({
        where: { id: history.id },
        data: { status: "completed" },
      });
      return res.json({
        message: "Upgraded successfully",
        clinic: serializeBillingClinic(updatedClinic),
        history,
      });
    }

    // initialize one-off charge for the delta
    const checkout = await initializeOneOffCharge({
      clinic,
      actor: req.user,
      amount: amountDueKobo,
      description: `Upgrade to ${requestedPlan}`,
    });

    // attach paystack reference to history
    await prisma.subscriptionHistory.update({
      where: { id: history.id },
      data: { paystackReference: checkout.reference },
    });

    return res.status(201).json({ checkout, history });
  } catch (error) {
    console.error("Upgrade subscription error:", error);
    return res
      .status(error.statusCode || 500)
      .json({ message: error.message || "Failed to initiate upgrade" });
  }
};

export const cancelPaystackSubscription = async (req, res) => {
  try {
    let clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    clinic = await recoverClinicPaystackSubscription(clinic, {
      forceRefresh: true,
    });

    if (
      !clinic.paystackSubscriptionCode ||
      !clinic.paystackSubscriptionEmailToken
    ) {
      return res.status(400).json({
        message:
          "This clinic does not have enough Paystack subscription data to cancel auto-renew yet.",
      });
    }

    let alreadyInactive = false;

    try {
      await disablePaystackSubscription({
        subscriptionCode: clinic.paystackSubscriptionCode,
        emailToken: clinic.paystackSubscriptionEmailToken,
      });
    } catch (error) {
      if (!isInactivePaystackSubscriptionError(error)) {
        throw error;
      }

      alreadyInactive = true;
    }

    const updatedClinic = await prisma.clinic.update({
      where: { id: clinic.id },
      data: {
        paystackSubscriptionStatus: "non-renewing",
      },
    });

    const auditScope = getSubscriptionAuditScope(req);

    await logAuditEvent(req, {
      action: `${auditScope.actionPrefix}.subscription_cancelled`,
      resourceType: auditScope.resourceType,
      resourceId: clinic.id,
      metadata: {
        status: "non-renewing",
        alreadyInactive,
        page: "upgrade",
        previousPlan: clinic.plan,
      },
    });

    return res.json({
      message: alreadyInactive
        ? "Auto-renew was already disabled for this subscription."
        : "Auto-renew has been disabled. This subscription will stay active until the current paid period ends.",
      clinic: serializeBillingClinic(updatedClinic),
    });
  } catch (error) {
    console.error("Cancel Paystack subscription error:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to cancel Paystack subscription",
    });
  }
};

export const resumePaystackSubscription = async (req, res) => {
  try {
    let clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    clinic = await recoverClinicPaystackSubscription(clinic, {
      forceRefresh: true,
    });

    if (
      !clinic.paystackSubscriptionCode ||
      !clinic.paystackSubscriptionEmailToken
    ) {
      return res.status(400).json({
        message:
          "This clinic does not have enough Paystack subscription data to resume auto-renew yet.",
      });
    }

    if (isFinalPaystackSubscriptionStatus(clinic)) {
      return res.status(400).json({
        message: cannotResumeSubscriptionMessage,
        clinic: serializeBillingClinic(clinic),
      });
    }

    await enablePaystackSubscription({
      subscriptionCode: clinic.paystackSubscriptionCode,
      emailToken: clinic.paystackSubscriptionEmailToken,
    });

    const updatedClinic = await prisma.clinic.update({
      where: { id: clinic.id },
      data: {
        paystackSubscriptionStatus: "active",
      },
    });

    const auditScope = getSubscriptionAuditScope(req);

    await logAuditEvent(req, {
      action: `${auditScope.actionPrefix}.subscription_resumed`,
      resourceType: auditScope.resourceType,
      resourceId: clinic.id,
      metadata: {
        status: "active",
        page: "upgrade",
        plan: updatedClinic.plan,
      },
    });

    return res.json({
      message: "Auto-renew has been resumed for this subscription.",
      clinic: serializeBillingClinic(updatedClinic),
    });
  } catch (error) {
    console.error("Resume Paystack subscription error:", error);

    if (isCannotReactivatePaystackSubscriptionError(error)) {
      return res.status(400).json({
        message: cannotResumeSubscriptionMessage,
      });
    }

    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to resume Paystack subscription",
    });
  }
};
export const handlePaystackWebhook = async (req, res) => {
  const signature = String(req.headers["x-paystack-signature"] || "");
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

  try {
    if (!signature || !verifyPaystackSignature(rawBody, signature)) {
      return res.status(401).json({ message: "Invalid Paystack signature" });
    }

    const event = JSON.parse(rawBody.toString("utf8"));

    // Compute a deterministic idempotency key for this webhook using payload hash
    const eventHash = crypto.createHash("sha256").update(rawBody).digest("hex");

    try {
      // Persist webhook for processing and auditing. If DB isn't available, fall back to file logging.
      await prisma.billingWebhook.create({
        data: {
          id: eventHash,
          eventType: String(event?.event || "").slice(0, 200),
          payload: event,
          signature: signature || null,
        },
      });
    } catch (dbError) {
      // If a unique constraint prevents creation, this event was already received — ignore
      if (
        !String(dbError?.message || "")
          .toLowerCase()
          .includes("unique")
      ) {
        try {
          // fallback: append to local webhook log
          const { appendFile } = await import("fs/promises");
          await appendFile(
            new URL("../../uploads/logs/paystack_webhooks.log", import.meta.url)
              .pathname,
            JSON.stringify({
              id: eventHash,
              event,
              signature,
              receivedAt: new Date().toISOString(),
            }) + "\n",
          );
        } catch (fileErr) {
          console.error(
            "Failed to persist Paystack webhook to DB or file:",
            fileErr,
          );
        }
      }
    }

    // Process asynchronously (fire-and-forget). Use a microtask so we don't await.
    void (async () => {
      try {
        await processPaystackWebhookEvent(event);
        // mark processed if DB available
        try {
          await prisma.billingWebhook.update({
            where: { id: eventHash },
            data: { processed: true, processedAt: new Date() },
          });
        } catch (_) {
          // ignore
        }
      } catch (procErr) {
        console.error("Error processing Paystack webhook event:", procErr);
      }
    })();

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Paystack webhook error:", error);
    return res
      .status(500)
      .json({ message: "Failed to process Paystack webhook" });
  }
};
