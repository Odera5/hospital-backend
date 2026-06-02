import express from "express";
import { prisma } from "../lib/prisma.js";
import { protect, authorizeRoles } from "../middleware/authorize.js";
import { decryptPatientValue } from "../utils/patientCrypto.js";

const router = express.Router();

router.use(protect);
router.use(authorizeRoles("admin"));

// Fetch paginated and filtered audit logs
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const { action, resourceType, actorId, search, startDate, endDate } = req.query;

    const clinicScopeWhere = {
      OR: [
        { actor: { clinicId: req.user.clinicId } },
        { patient: { clinicId: req.user.clinicId } },
      ],
    };

    const where = {
      AND: [
        clinicScopeWhere,
        {
          ...(action ? { action: String(action) } : {}),
          ...(resourceType ? { resourceType: String(resourceType) } : {}),
          ...(actorId ? { actorId: String(actorId) } : {}),
          ...((startDate || endDate)
            ? {
                createdAt: {
                  ...(startDate ? { gte: new Date(`${startDate}T00:00:00.000Z`) } : {}),
                  ...(endDate ? { lte: new Date(`${endDate}T23:59:59.999Z`) } : {}),
                },
              }
            : {}),
          ...(search
            ? {
                OR: [
                  { action: { contains: String(search), mode: "insensitive" } },
                  { resourceType: { contains: String(search), mode: "insensitive" } },
                  { actor: { name: { contains: String(search), mode: "insensitive" } } },
                  // Note: Patient name is encrypted in db, so text search matches on schema won't find it directly.
                  // We handle text search for decrypted patient names if needed, but standard action/type search is fine.
                ],
              }
            : {}),
        },
      ],
    };

    const [logs, total, actionsGroup, resourcesGroup, actors] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          actor: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
            },
          },
          patient: {
            select: {
              id: true,
              name: true,
              cardNumber: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.auditLog.count({ where }),
      prisma.auditLog.groupBy({
        by: ["action"],
        where: clinicScopeWhere,
      }),
      prisma.auditLog.groupBy({
        by: ["resourceType"],
        where: clinicScopeWhere,
      }),
      prisma.user.findMany({
        where: { clinicId: req.user.clinicId },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
        },
        orderBy: { name: "asc" },
      }),
    ]);

    const decryptedLogs = logs.map((log) => {
      const result = { ...log };
      if (result.patient) {
        result.patient = {
          id: result.patient.id,
          name: decryptPatientValue(result.patient.name),
          cardNumber: decryptPatientValue(result.patient.cardNumber),
        };
      }
      return result;
    });

    res.json({
      data: decryptedLogs,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      filters: {
        actions: actionsGroup.map((g) => g.action).filter(Boolean),
        resourceTypes: resourcesGroup.map((g) => g.resourceType).filter(Boolean),
        actors,
      },
    });
  } catch (error) {
    console.error("Fetch audit logs error:", error);
    res.status(500).json({ message: "Failed to fetch activity logs" });
  }
});

export default router;
