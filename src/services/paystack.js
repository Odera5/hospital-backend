import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import {
  hasActivePaidSubscription,
  hasEnterpriseAccess,
  hasActiveProAccess,
  isTrialingClinic,
} from "../utils/subscriptionAccess.js";

const PAYSTACK_API_BASE_URL = "https://api.paystack.co";
const PRO_PLAN_TYPE = "PRO";
const ENTERPRISE_PLAN_TYPE = "ENTERPRISE";
const PRO_PLAN_NAME = "PrimuxCare Pro Monthly";
const PRO_PLAN_DESCRIPTION =
  "PrimuxCare Pro monthly subscription for clinics in Nigeria";
const MONTHLY_INTERVAL = "monthly";
const DEFAULT_PRO_AMOUNT_KOBO = 10000000;
const ENTERPRISE_PLAN_NAME = "PrimuxCare Enterprise Monthly";
const ENTERPRISE_PLAN_DESCRIPTION =
  "PrimuxCare Enterprise monthly subscription for multi-branch clinics in Nigeria";
const DEFAULT_ENTERPRISE_AMOUNT_KOBO = 15000000;

const PRO_PLAN_NAME_ANNUAL = "PrimuxCare Pro Annual";
const PRO_PLAN_DESCRIPTION_ANNUAL =
  "PrimuxCare Pro annual subscription for clinics in Nigeria";
const ANNUAL_INTERVAL = "annually";
const DEFAULT_PRO_AMOUNT_KOBO_ANNUAL = 100000000;

const ENTERPRISE_PLAN_NAME_ANNUAL = "PrimuxCare Enterprise Annual";
const ENTERPRISE_PLAN_DESCRIPTION_ANNUAL =
  "PrimuxCare Enterprise annual subscription for multi-branch clinics in Nigeria";
const DEFAULT_ENTERPRISE_AMOUNT_KOBO_ANNUAL = 150000000;
export const SUPPORTED_PLAN_TYPES = [PRO_PLAN_TYPE, ENTERPRISE_PLAN_TYPE];
export const SUPPORTED_BILLING_INTERVALS = [
  MONTHLY_INTERVAL,
  ANNUAL_INTERVAL,
];

export const parseRequestedBillingInterval = (interval) => {
  const normalizedInterval = String(interval || "")
    .trim()
    .toLowerCase();

  if (SUPPORTED_BILLING_INTERVALS.includes(normalizedInterval)) {
    return normalizedInterval;
  }

  const error = new Error(
    `Unsupported billing interval. Supported intervals: ${SUPPORTED_BILLING_INTERVALS.join(", ")}.`,
  );
  error.statusCode = 400;
  throw error;
};

export const parseRequestedPlanType = (planType) => {
  const normalizedPlanType = String(planType || PRO_PLAN_TYPE)
    .trim()
    .toUpperCase();

  if (SUPPORTED_PLAN_TYPES.includes(normalizedPlanType)) {
    return normalizedPlanType;
  }

  const error = new Error(
    `Unsupported plan type. Supported plan types: ${SUPPORTED_PLAN_TYPES.join(", ")}.`,
  );
  error.statusCode = 400;
  throw error;
};

const resolveBaseUrl = () =>
  process.env.APP_BASE_URL?.trim() ||
  process.env.FRONTEND_URL?.trim() ||
  process.env.CORS_ORIGIN?.split(",")[0]?.trim() ||
  "http://localhost:5173";

const requirePaystackSecretKey = () => {
  const key = process.env.PAYSTACK_SECRET_KEY?.trim();

  if (!key) {
    const error = new Error(
      "Paystack is not configured. Set PAYSTACK_SECRET_KEY before starting billing.",
    );
    error.statusCode = 500;
    throw error;
  }

  return key;
};

const getPlanConfig = (planType = PRO_PLAN_TYPE, interval = MONTHLY_INTERVAL) => {
  const normalizedPlanType = parseRequestedPlanType(planType);
  const normalizedInterval = parseRequestedBillingInterval(interval);

  if (normalizedPlanType === ENTERPRISE_PLAN_TYPE) {
    if (normalizedInterval === ANNUAL_INTERVAL) {
      const configuredAmount = Number(process.env.PAYSTACK_ENTERPRISE_PLAN_AMOUNT_KOBO_ANNUAL);
      return {
        planType: ENTERPRISE_PLAN_TYPE,
        name: ENTERPRISE_PLAN_NAME_ANNUAL,
        description: ENTERPRISE_PLAN_DESCRIPTION_ANNUAL,
        amount: Number.isFinite(configuredAmount) && configuredAmount > 0
          ? Math.round(configuredAmount)
          : DEFAULT_ENTERPRISE_AMOUNT_KOBO_ANNUAL,
        interval: ANNUAL_INTERVAL,
        envPlanCode: process.env.PAYSTACK_ENTERPRISE_PLAN_CODE_ANNUAL?.trim(),
      };
    }

    const configuredAmount = Number(process.env.PAYSTACK_ENTERPRISE_PLAN_AMOUNT_KOBO);
    return {
      planType: ENTERPRISE_PLAN_TYPE,
      name: ENTERPRISE_PLAN_NAME,
      description: ENTERPRISE_PLAN_DESCRIPTION,
      amount: Number.isFinite(configuredAmount) && configuredAmount > 0
        ? Math.round(configuredAmount)
        : DEFAULT_ENTERPRISE_AMOUNT_KOBO,
      interval: MONTHLY_INTERVAL,
      envPlanCode: process.env.PAYSTACK_ENTERPRISE_PLAN_CODE?.trim(),
    };
  }

  if (normalizedInterval === ANNUAL_INTERVAL) {
    const configuredAmount = Number(process.env.PAYSTACK_PRO_PLAN_AMOUNT_KOBO_ANNUAL);
    return {
      planType: PRO_PLAN_TYPE,
      name: PRO_PLAN_NAME_ANNUAL,
      description: PRO_PLAN_DESCRIPTION_ANNUAL,
      amount: Number.isFinite(configuredAmount) && configuredAmount > 0
        ? Math.round(configuredAmount)
        : DEFAULT_PRO_AMOUNT_KOBO_ANNUAL,
      interval: ANNUAL_INTERVAL,
      envPlanCode: process.env.PAYSTACK_PRO_PLAN_CODE_ANNUAL?.trim(),
    };
  }

  const configuredAmount = Number(process.env.PAYSTACK_PRO_PLAN_AMOUNT_KOBO);
  return {
    planType: PRO_PLAN_TYPE,
    name: PRO_PLAN_NAME,
    description: PRO_PLAN_DESCRIPTION,
    amount: Number.isFinite(configuredAmount) && configuredAmount > 0
      ? Math.round(configuredAmount)
      : DEFAULT_PRO_AMOUNT_KOBO,
    interval: MONTHLY_INTERVAL,
    envPlanCode: process.env.PAYSTACK_PRO_PLAN_CODE?.trim(),
  };
};

const getPaystackHeaders = () => ({
  Authorization: `Bearer ${requirePaystackSecretKey()}`,
  "Content-Type": "application/json",
});

const callPaystack = async (path, options = {}) => {
  const response = await fetch(`${PAYSTACK_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...getPaystackHeaders(),
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.status) {
    const error = new Error(
      payload?.message || `Paystack request failed with status ${response.status}`,
    );
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }

  return payload.data;
};

const addMonths = (dateInput, months) => {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  date.setMonth(date.getMonth() + months);
  return date;
};

const computeSubscriptionEndDate = ({
  paidAt,
  interval = MONTHLY_INTERVAL,
  currentSubscriptionEnds,
}) => {
  const anchor =
    currentSubscriptionEnds && new Date(currentSubscriptionEnds) > new Date()
      ? new Date(currentSubscriptionEnds)
      : new Date(paidAt || Date.now());

  if (Number.isNaN(anchor.getTime())) {
    return null;
  }

  switch (interval) {
    case "annually":
      return addMonths(anchor, 12);
    case "biannually":
      return addMonths(anchor, 6);
    case "quarterly":
      return addMonths(anchor, 3);
    case "weekly":
      return new Date(anchor.getTime() + 7 * 24 * 60 * 60 * 1000);
    case "daily":
      return new Date(anchor.getTime() + 24 * 60 * 60 * 1000);
    case "monthly":
    default:
      return addMonths(anchor, 1);
  }
};

const resolveMetadataClinicId = (payload) =>
  payload?.metadata?.clinicId ||
  payload?.metadata?.custom_fields?.find(
    (field) => field?.variable_name === "clinic_id",
  )?.value ||
  null;

const findClinicForTransaction = async (transaction) => {
  const clinicId = resolveMetadataClinicId(transaction);

  if (clinicId) {
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
    if (clinic) {
      return clinic;
    }
  }

  const customerEmail = transaction?.customer?.email?.trim().toLowerCase();
  if (!customerEmail) {
    return null;
  }

  return prisma.clinic.findUnique({
    where: { email: customerEmail },
  });
};

const buildCustomFields = (clinic) => [
  {
    display_name: "Clinic ID",
    variable_name: "clinic_id",
    value: clinic.id,
  },
  {
    display_name: "Clinic Name",
    variable_name: "clinic_name",
    value: clinic.name,
  },
];

export const serializeBillingClinic = (clinic) => ({
  id: clinic.id,
  plan: clinic.plan || "PRO",
  subscriptionEnds: clinic.subscriptionEnds || null,
  paystackCustomerCode: clinic.paystackCustomerCode || null,
  paystackPlanCode: clinic.paystackPlanCode || null,
  paystackSubscriptionCode: clinic.paystackSubscriptionCode || null,
  paystackSubscriptionStatus: clinic.paystackSubscriptionStatus || null,
  paystackNextPaymentDate: clinic.paystackNextPaymentDate || null,
  paystackLastReference: clinic.paystackLastReference || null,
  hasActivePaidSubscription: hasActivePaidSubscription(clinic),
  hasActiveProAccess: hasActiveProAccess(clinic),
  hasEnterpriseAccess: hasEnterpriseAccess(clinic),
  isTrialing: isTrialingClinic(clinic),
});

const inferPlanTypeFromPlanDetails = (transaction) => {
  const envEnterprisePlanCode = process.env.PAYSTACK_ENTERPRISE_PLAN_CODE?.trim();
  const envEnterprisePlanCodeAnnual = process.env.PAYSTACK_ENTERPRISE_PLAN_CODE_ANNUAL?.trim();
  const envProPlanCodeMonthly = process.env.PAYSTACK_PRO_PLAN_CODE?.trim();
  const envProPlanCodeAnnual = process.env.PAYSTACK_PRO_PLAN_CODE_ANNUAL?.trim();
  const planCode = String(
    transaction?.plan_object?.plan_code ||
      transaction?.plan?.plan_code ||
      "",
  ).trim();
  const planName = String(
    transaction?.plan_object?.name ||
      transaction?.plan?.name ||
      "",
  ).trim().toLowerCase();
  const amount = Number(
    transaction?.plan_object?.amount ??
      transaction?.plan?.amount ??
      transaction?.amount,
  );

  if (
    (envEnterprisePlanCode && planCode === envEnterprisePlanCode) ||
    (envEnterprisePlanCodeAnnual && planCode === envEnterprisePlanCodeAnnual)
  ) {
    return ENTERPRISE_PLAN_TYPE;
  }

  if (
    (envProPlanCodeMonthly && planCode === envProPlanCodeMonthly) ||
    (envProPlanCodeAnnual && planCode === envProPlanCodeAnnual)
  ) {
    return PRO_PLAN_TYPE;
  }

  if (planName.includes("enterprise")) {
    return ENTERPRISE_PLAN_TYPE;
  }

  if (planName.includes("pro")) {
    return PRO_PLAN_TYPE;
  }

  if (
    Number.isFinite(amount) &&
    (amount === DEFAULT_ENTERPRISE_AMOUNT_KOBO ||
      amount === DEFAULT_ENTERPRISE_AMOUNT_KOBO_ANNUAL)
  ) {
    return ENTERPRISE_PLAN_TYPE;
  }

  return null;
};

const resolveTransactionPlanType = (transaction, fallbackPlanType = PRO_PLAN_TYPE) => {
  const metadataPlanType = String(transaction?.metadata?.plan || "")
    .trim()
    .toUpperCase();

  if (SUPPORTED_PLAN_TYPES.includes(metadataPlanType)) {
    return metadataPlanType;
  }

  const inferredPlanType = inferPlanTypeFromPlanDetails(transaction);
  if (inferredPlanType) {
    return inferredPlanType;
  }

  return parseRequestedPlanType(fallbackPlanType);
};

export const ensurePaystackPlan = async (
  clinic,
  planType = PRO_PLAN_TYPE,
  interval = MONTHLY_INTERVAL,
) => {
  const config = getPlanConfig(planType, interval);

  // If env plan code is set, use it. We'll optionally save it to clinic later
  // if they successfully subscribe.
  if (config.envPlanCode) {
    return config.envPlanCode;
  }

  // If no env plan code, and clinic already has a plan code matching this interval,
  // we could reuse it, but we don't strictly know if it matches the interval.
  // To be safe, we just create a new plan if we don't have it configured in .env.
  const createdPlan = await callPaystack("/plan", {
    method: "POST",
    body: JSON.stringify({
      name: config.name,
      amount: config.amount,
      interval: config.interval,
      description: config.description,
      currency: "NGN",
      send_invoices: true,
      send_sms: false,
    }),
  });

  return createdPlan.plan_code;
};

export const initializePaystackSubscription = async ({
  clinic,
  actor,
  planType = PRO_PLAN_TYPE,
  interval = MONTHLY_INTERVAL,
}) => {
  const normalizedPlanType = parseRequestedPlanType(planType);
  const planCode = await ensurePaystackPlan(clinic, normalizedPlanType, interval);
  const config = getPlanConfig(normalizedPlanType, interval);
  const reference = `pcare-${clinic.id}-${Date.now()}`;
  const callbackBaseUrl = resolveBaseUrl().replace(/\/$/, "");

  const data = await callPaystack("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: clinic.email,
      amount: config.amount,
      plan: planCode,
      currency: "NGN",
      reference,
      callback_url: `${callbackBaseUrl}/billing/paystack/callback`,
      metadata: {
        clinicId: clinic.id,
        clinicName: clinic.name,
        actorId: actor.id,
        actorEmail: actor.email,
        plan: normalizedPlanType,
        interval: config.interval,
        custom_fields: buildCustomFields(clinic),
      },
    }),
  });

  await prisma.clinic.update({
    where: { id: clinic.id },
    data: {
      paystackLastReference: data.reference,
    },
  });

  return {
    authorizationUrl: data.authorization_url,
    accessCode: data.access_code,
    reference: data.reference,
  };
};

export const syncClinicWithTransaction = async (transaction) => {
  const clinic = await findClinicForTransaction(transaction);

  if (!clinic) {
    return null;
  }

  const resolvedPlanType = resolveTransactionPlanType(transaction, clinic.plan);

  const transactionReference = transaction?.reference || null;
  const alreadyProcessedReference = Boolean(
    transactionReference &&
    clinic.paystackLastReference === transactionReference &&
    clinic.paystackSubscriptionStatus &&
    clinic.subscriptionEnds,
  );

  const subscriptionEnds = alreadyProcessedReference
    ? clinic.subscriptionEnds
    : computeSubscriptionEndDate({
        paidAt: transaction?.paid_at || transaction?.paidAt || transaction?.created_at,
        interval:
          transaction?.plan_object?.interval ||
          transaction?.plan?.interval ||
          MONTHLY_INTERVAL,
        currentSubscriptionEnds: clinic.subscriptionEnds,
      });

  const updatedClinic = await prisma.clinic.update({
    where: { id: clinic.id },
    data: {
      plan: resolvedPlanType,
      paystackCustomerCode:
        transaction?.customer?.customer_code || clinic.paystackCustomerCode,
      paystackPlanCode:
        transaction?.plan_object?.plan_code ||
        transaction?.plan?.plan_code ||
        clinic.paystackPlanCode,
      paystackSubscriptionCode:
        transaction?.subscription?.subscription_code ||
        transaction?.subscription_code ||
        clinic.paystackSubscriptionCode,
      paystackSubscriptionStatus:
        transaction?.subscription?.status ||
        (transaction?.status === "success" ? "active" : transaction?.status) ||
        clinic.paystackSubscriptionStatus ||
        "active",
      paystackSubscriptionEmailToken:
        transaction?.subscription?.email_token ||
        transaction?.email_token ||
        clinic.paystackSubscriptionEmailToken,
      paystackAuthorizationCode:
        transaction?.authorization?.authorization_code ||
        clinic.paystackAuthorizationCode,
      paystackLastReference: transactionReference || clinic.paystackLastReference,
      paystackNextPaymentDate:
        transaction?.subscription?.next_payment_date
          ? new Date(transaction.subscription.next_payment_date)
          : transaction?.next_payment_date
            ? new Date(transaction.next_payment_date)
            : clinic.paystackNextPaymentDate,
      subscriptionEnds: subscriptionEnds || clinic.subscriptionEnds,
    },
  });

  return updatedClinic;
};

export const fetchPaystackTransaction = async (reference) => {
  return callPaystack(
    `/transaction/verify/${encodeURIComponent(reference)}`,
    { method: "GET" },
  );
};

export const verifyPaystackTransaction = async (reference) => {
  const transaction = await fetchPaystackTransaction(reference);

  if (transaction.status !== "success") {
    const error = new Error(
      `Paystack transaction is ${transaction.status || "not successful"}`,
    );
    error.statusCode = 400;
    error.payload = transaction;
    throw error;
  }

  const clinic = await syncClinicWithTransaction(transaction);

  return { transaction, clinic };
};

export const disableClinicSubscription = async (clinicId, status = "disabled") =>
  prisma.clinic.update({
    where: { id: clinicId },
    data: {
      paystackSubscriptionStatus: status,
      subscriptionEnds: null,
    },
  });

export const processPaystackWebhookEvent = async (event) => {
  const eventType = String(event?.event || "").trim();
  const payload = event?.data || {};

  if (!eventType) {
    return null;
  }

  if (eventType === "charge.success") {
    return syncClinicWithTransaction(payload);
  }

  if (eventType === "subscription.create" || eventType === "subscription.not_renew") {
    const clinic = await findClinicForTransaction(payload);
    if (!clinic) {
      return null;
    }

    return prisma.clinic.update({
      where: { id: clinic.id },
      data: {
        paystackCustomerCode:
          payload?.customer?.customer_code || clinic.paystackCustomerCode,
        paystackPlanCode: payload?.plan?.plan_code || clinic.paystackPlanCode,
        paystackSubscriptionCode:
          payload?.subscription_code || clinic.paystackSubscriptionCode,
        paystackSubscriptionStatus: payload?.status || "active",
        paystackSubscriptionEmailToken:
          payload?.email_token || clinic.paystackSubscriptionEmailToken,
        paystackNextPaymentDate: payload?.next_payment_date
          ? new Date(payload.next_payment_date)
          : clinic.paystackNextPaymentDate,
      },
    });
  }

  if (
    eventType === "subscription.disable" ||
    eventType === "invoice.payment_failed"
  ) {
    const clinic = await findClinicForTransaction(payload);
    if (!clinic) {
      return null;
    }

    return disableClinicSubscription(clinic.id, eventType);
  }

  return null;
};

export const verifyPaystackSignature = (rawBody, signature) => {
  const secretKey = requirePaystackSecretKey();

  const expectedSignature = crypto
    .createHmac("sha512", secretKey)
    .update(rawBody)
    .digest("hex");

  return expectedSignature === signature;
};

export const generatePaystackManageLink = async (subscriptionCode) => {
  const data = await callPaystack(
    `/subscription/${encodeURIComponent(subscriptionCode)}/manage/link`,
    { method: "GET" },
  );

  return data?.link || null;
};

export const disablePaystackSubscription = async ({
  subscriptionCode,
  emailToken,
}) => {
  await callPaystack("/subscription/disable", {
    method: "POST",
    body: JSON.stringify({
      code: subscriptionCode,
      token: emailToken,
    }),
  });
};

export const enablePaystackSubscription = async ({
  subscriptionCode,
  emailToken,
}) => {
  await callPaystack("/subscription/enable", {
    method: "POST",
    body: JSON.stringify({
      code: subscriptionCode,
      token: emailToken,
    }),
  });
};

export const isInactivePaystackSubscriptionError = (error) => {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("subscription") &&
    (message.includes("already inactive") || message.includes("not found or already inactive"));
};

export const fetchCustomerSubscriptions = async (customerCode) => {
  return callPaystack(`/subscription?customer=${encodeURIComponent(customerCode)}`, {
    method: "GET",
  });
};

export const fetchPaystackCustomer = async (emailOrCode) => {
  return callPaystack(`/customer/${encodeURIComponent(emailOrCode)}`, {
    method: "GET",
  });
};

const usableSubscriptionStatuses = ["active", "non-renewing", "attention"];

const subscriptionMatchesClinicPlan = (subscription, clinic) => {
  if (!clinic.paystackPlanCode) {
    return true;
  }

  return subscription?.plan?.plan_code === clinic.paystackPlanCode;
};

const chooseRecoverableSubscription = (subscriptions, clinic) => {
  const candidates = (Array.isArray(subscriptions) ? subscriptions : [])
    .filter((subscription) => subscription?.subscription_code && subscription?.email_token);

  return candidates.find((subscription) =>
    usableSubscriptionStatuses.includes(String(subscription.status || "").toLowerCase()) &&
    subscriptionMatchesClinicPlan(subscription, clinic)
  ) || candidates.find((subscription) =>
    usableSubscriptionStatuses.includes(String(subscription.status || "").toLowerCase())
  ) || candidates[0] || null;
};

const applyRecoveredSubscription = async (clinic, subscription) => {
  if (!subscription?.subscription_code || !subscription?.email_token) {
    return clinic;
  }

  return prisma.clinic.update({
    where: { id: clinic.id },
    data: {
      paystackSubscriptionCode: subscription.subscription_code,
      paystackSubscriptionEmailToken: subscription.email_token,
      paystackSubscriptionStatus: subscription.status || clinic.paystackSubscriptionStatus,
      paystackNextPaymentDate: subscription.next_payment_date
        ? new Date(subscription.next_payment_date)
        : clinic.paystackNextPaymentDate,
    },
  });
};

const recoverableSubscriptionFromTransaction = (transaction) => {
  const subscription = transaction?.subscription || {};

  return {
    subscription_code:
      subscription.subscription_code || transaction?.subscription_code || null,
    email_token: subscription.email_token || transaction?.email_token || null,
    status: subscription.status || (transaction?.status === "success" ? "active" : null),
    next_payment_date: subscription.next_payment_date || transaction?.next_payment_date || null,
  };
};

export const recoverClinicPaystackSubscription = async (
  clinic,
  { forceRefresh = false } = {},
) => {
  let recoveredClinic = clinic;

  if (recoveredClinic.paystackLastReference) {
    try {
      const transaction = await fetchPaystackTransaction(recoveredClinic.paystackLastReference);
      recoveredClinic = await applyRecoveredSubscription(
        recoveredClinic,
        recoverableSubscriptionFromTransaction(transaction),
      );
    } catch (error) {
      console.error("Failed to recover subscription from last Paystack reference:", error);
    }
  }

  if (
    !forceRefresh &&
    recoveredClinic.paystackSubscriptionCode &&
    recoveredClinic.paystackSubscriptionEmailToken
  ) {
    return recoveredClinic;
  }

  const subscriptionSources = [];
  const customerLookups = [
    recoveredClinic.paystackCustomerCode,
    recoveredClinic.email,
  ].filter(Boolean);

  for (const customerLookup of [...new Set(customerLookups)]) {
    try {
      const customer = await fetchPaystackCustomer(customerLookup);
      if (Array.isArray(customer?.subscriptions)) {
        subscriptionSources.push(customer.subscriptions);
      }

      if (customer?.id) {
        const subscriptions = await fetchCustomerSubscriptions(customer.id);
        subscriptionSources.push(subscriptions);
      }
    } catch (error) {
      console.error("Failed to recover subscription from Paystack customer:", error);
    }
  }

  for (const subscriptions of subscriptionSources) {
    const subscription = chooseRecoverableSubscription(subscriptions, recoveredClinic);
    if (subscription) {
      recoveredClinic = await applyRecoveredSubscription(recoveredClinic, subscription);
      break;
    }
  }

  return recoveredClinic;
};
