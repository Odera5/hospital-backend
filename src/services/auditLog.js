import { prisma } from "../lib/prisma.js";

const resolveActorId = (user) => user?.id || user?._id || null;

const buildAuditLogData = (req, details) => {
  let ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || req.ip || "";
  if (ip?.includes(",")) ip = ip.split(",")[0].trim();
  if (ip?.startsWith("::ffff:")) ip = ip.substring(7);
  if (ip === "::1") ip = "127.0.0.1";

  return {
    actorId: resolveActorId(req.user),
    actorRole: req.user?.role || "",
    action: details.action,
    resourceType: details.resourceType,
    resourceId: details.resourceId ? String(details.resourceId) : "",
    patientId: details.patientId || null,
    branchId:
      details.branchId !== undefined
        ? details.branchId
        : req.user?.branchId || null,
    metadata: details.metadata || {},
    ipAddress: ip,
  };
};

const createAuditFailure = (cause) =>
  Object.assign(
    new Error(
      "Activity logging is temporarily unavailable. The action was not completed. Please try again.",
      { cause },
    ),
    { code: "AUDIT_LOG_UNAVAILABLE" },
  );

export const requireAuditEvent = async (req, details) => {
  try {
    return await prisma.auditLog.create({
      data: buildAuditLogData(req, details),
    });
  } catch (error) {
    console.error("Required audit log write failed:", error);
    throw createAuditFailure(error);
  }
};

export const withAuditedTransaction = async (
  req,
  resolveDetails,
  operation,
  options,
) =>
  prisma.$transaction(async (transaction) => {
    const result = await operation(transaction);
    const details =
      typeof resolveDetails === "function"
        ? resolveDetails(result)
        : resolveDetails;
    const entries = Array.isArray(details) ? details : [details];

    try {
      await transaction.auditLog.createMany({
        data: entries.map((entry) => buildAuditLogData(req, entry)),
      });
    } catch (error) {
      console.error("Transactional audit log write failed:", error);
      throw createAuditFailure(error);
    }

    return result;
  }, options);

export const isAuditLogUnavailable = (error) =>
  error?.code === "AUDIT_LOG_UNAVAILABLE";

export const logAuditEvent = async (req, details) => {
  try {
    return await prisma.auditLog.create({
      data: buildAuditLogData(req, details),
    });
  } catch (error) {
    console.error("Non-blocking audit log write failed:", error);
    return null;
  }
};
