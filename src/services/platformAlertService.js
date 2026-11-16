import { sendAdminOperationalAlert } from "./emailVerification.js";

const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const lastAlertSentAt = new Map();

export const notifyAdminOperationalIssue = async (source) => {
  const alertSource = String(source || "background service").slice(0, 100);
  const now = Date.now();
  const lastSentAt = lastAlertSentAt.get(alertSource);

  if (lastSentAt && now - lastSentAt < ALERT_COOLDOWN_MS) return false;
  lastAlertSentAt.set(alertSource, now);

  try {
    await sendAdminOperationalAlert({
      source: alertSource,
      occurredAt: new Date(now),
    });
    return true;
  } catch (error) {
    console.error(
      `[Admin Alerts] Failed to send operational alert for ${alertSource}:`,
      error,
    );
    return false;
  }
};
