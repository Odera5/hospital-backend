import { prisma } from "../lib/prisma.js";
import {
  disablePaystackSubscription,
  generatePaystackManageLink,
  initializePaystackSubscription,
  processPaystackWebhookEvent,
  serializeBillingClinic,
  verifyPaystackSignature,
  verifyPaystackTransaction,
} from "../services/paystack.js";

export const getBillingOverview = async (req, res) => {
  try {
    const clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    return res.json({ clinic: serializeBillingClinic(clinic) });
  } catch (error) {
    console.error("Get billing overview error:", error);
    return res.status(500).json({ message: "Failed to load billing details" });
  }
};

export const initializePaystackCheckout = async (req, res) => {
  try {
    const clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    const checkout = await initializePaystackSubscription({
      clinic,
      actor: req.user,
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
        message: "This clinic does not have an active Paystack subscription yet.",
      });
    }

    const link = await generatePaystackManageLink(clinic.paystackSubscriptionCode);

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
    const reference = String(req.query?.reference || req.body?.reference || "").trim();

    if (!reference) {
      return res.status(400).json({ message: "Payment reference is required" });
    }

    const { clinic, transaction } = await verifyPaystackTransaction(reference);

    if (!clinic || clinic.id !== req.user.clinicId) {
      return res.status(404).json({ message: "Clinic billing record not found" });
    }

    return res.json({
      message: "Paystack subscription activated successfully",
      clinic: serializeBillingClinic(clinic),
      transaction: {
        reference: transaction.reference,
        status: transaction.status,
        paidAt: transaction.paid_at || transaction.paidAt || null,
      },
    });
  } catch (error) {
    console.error("Verify Paystack checkout error:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to verify Paystack payment",
    });
  }
};

export const cancelPaystackSubscription = async (req, res) => {
  try {
    const clinic = await prisma.clinic.findUnique({
      where: { id: req.user.clinicId },
    });

    if (!clinic) {
      return res.status(404).json({ message: "Clinic not found" });
    }

    if (!clinic.paystackSubscriptionCode || !clinic.paystackSubscriptionEmailToken) {
      return res.status(400).json({
        message:
          "This clinic does not have enough Paystack subscription data to cancel auto-renew yet.",
      });
    }

    await disablePaystackSubscription({
      subscriptionCode: clinic.paystackSubscriptionCode,
      emailToken: clinic.paystackSubscriptionEmailToken,
    });

    const updatedClinic = await prisma.clinic.update({
      where: { id: clinic.id },
      data: {
        paystackSubscriptionStatus: "non-renewing",
      },
    });

    return res.json({
      message:
        "Auto-renew has been disabled. This subscription will stay active until the current paid period ends.",
      clinic: serializeBillingClinic(updatedClinic),
    });
  } catch (error) {
    console.error("Cancel Paystack subscription error:", error);
    return res.status(error.statusCode || 500).json({
      message: error.message || "Failed to cancel Paystack subscription",
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
    await processPaystackWebhookEvent(event);

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Paystack webhook error:", error);
    return res.status(500).json({ message: "Failed to process Paystack webhook" });
  }
};
