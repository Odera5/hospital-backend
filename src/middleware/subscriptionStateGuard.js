import {
  hasActiveProAccess,
  isSubscriptionExpired,
  getAdminSubscriptionExpiredMessage,
  getStaffSubscriptionExpiredMessage,
} from "../utils/subscriptionAccess.js";

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const buildExpiredPayload = ({ req, allowAdminReadOnly = false }) => {
  const isAdmin = req.user?.role === "admin";

  return {
    message: isAdmin
      ? getAdminSubscriptionExpiredMessage()
      : getStaffSubscriptionExpiredMessage(),
    errorCode: "SUBSCRIPTION_EXPIRED",
    subscriptionState: "expired",
    readOnlyMode: Boolean(isAdmin && allowAdminReadOnly),
  };
};

export const enforceSubscriptionState =
  ({ allowAdminReadOnly = false } = {}) =>
  (req, res, next) => {
    const clinic = req.user?.clinic;

    if (!clinic || hasActiveProAccess(clinic) || !isSubscriptionExpired(clinic)) {
      return next();
    }

    const isAdmin = req.user?.role === "admin";

    if (isAdmin && allowAdminReadOnly && READ_ONLY_METHODS.has(req.method)) {
      return next();
    }

    return res.status(403).json(
      buildExpiredPayload({
        req,
        allowAdminReadOnly,
      }),
    );
  };
