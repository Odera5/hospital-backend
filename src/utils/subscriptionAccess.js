export const ACTIVE_PAYSTACK_SUBSCRIPTION_STATUSES = [
  "active",
  "attention",
  "success",
  "non-renewing",
];

export const hasActivePaidSubscription = (clinic) => {
  const hasStatus = ACTIVE_PAYSTACK_SUBSCRIPTION_STATUSES.includes(
    String(clinic?.paystackSubscriptionStatus || "").toLowerCase(),
  );
  if (!hasStatus) return false;

  if (clinic?.subscriptionEnds) {
    const end = new Date(clinic.subscriptionEnds);
    if (!Number.isNaN(end.getTime())) {
      return end >= new Date();
    }
  }
  return true;
};

export const hasFutureSubscriptionWindow = (clinic) => {
  if (!clinic?.subscriptionEnds) {
    return false;
  }

  const subscriptionEnd = new Date(clinic.subscriptionEnds);
  if (Number.isNaN(subscriptionEnd.getTime())) {
    return false;
  }

  return subscriptionEnd >= new Date();
};

export const hasActiveProAccess = (clinic) =>
  ["PRO", "ENTERPRISE"].includes(clinic?.plan) &&
  (hasActivePaidSubscription(clinic) || hasFutureSubscriptionWindow(clinic));

export const hasReminderAccess = (clinic) => hasActiveProAccess(clinic);

export const hasEnterpriseAccess = (clinic) =>
  clinic?.plan === "ENTERPRISE" && hasActiveProAccess(clinic);

export const isSubscriptionExpired = (clinic) =>
  ["PRO", "ENTERPRISE"].includes(clinic?.plan) && !hasActiveProAccess(clinic);

export const isTrialingClinic = (clinic) =>
  ["PRO", "ENTERPRISE"].includes(clinic?.plan) &&
  !hasActivePaidSubscription(clinic) &&
  hasFutureSubscriptionWindow(clinic);

export const isUpgradeRequired = (clinic) => !hasActiveProAccess(clinic);

export const getUpgradeRequiredMessage = () =>
  "Your clinic no longer has active Pro access. Upgrade your clinic to continue using CareChrome.";

export const getReminderAccessRequiredMessage = () =>
  "Automated reminders require active Pro access through your 14-day trial or paid Pro subscription.";

export const getAdminSubscriptionExpiredMessage = () =>
  "Your clinic's Pro trial or paid subscription has expired. Renew Pro to restore full access.";

export const getStaffSubscriptionExpiredMessage = () =>
  "Your clinic's Pro access has expired. Ask an admin to renew the subscription to continue.";
