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
        ipAddress: req.ip || "",
      },
    });
  } catch (error) {
    console.error("Audit log write failed:", error.message);
  }
};
