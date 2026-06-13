import { prisma } from "../lib/prisma.js";

const resolveActorId = (user) => user?.id || user?._id || null;

export const logAuditEvent = async (req, details) => {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: resolveActorId(req.user),
        actorRole: req.user?.role || "",
        action: details.action,
        resourceType: details.resourceType,
        resourceId: details.resourceId ? String(details.resourceId) : "",
        patientId: details.patientId || null,
        metadata: details.metadata || {},
        ipAddress: (() => {
          let ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || req.ip || "";
          if (ip) {
            if (ip.includes(",")) {
              ip = ip.split(",")[0].trim();
            }
            if (ip.startsWith("::ffff:")) {
              ip = ip.substring(7);
            }
            if (ip === "::1") {
              ip = "127.0.0.1";
            }
          }
          return ip;
        })(),
      },
    });
  } catch (error) {
    console.error("Audit log write failed:", error.message);
  }
};
