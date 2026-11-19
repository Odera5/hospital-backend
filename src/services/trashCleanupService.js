import fs from "fs";
import path from "path";
import { prisma } from "../lib/prisma.js";
import { deleteObjectFromS3 } from "../lib/s3.js";
import { notifyAdminOperationalIssue } from "./platformAlertService.js";

const RETENTION_MONTHS = 6;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;

let cleanupIntervalId = null;
let cleanupRunPromise = null;

export const getTrashExpiryCutoff = (now = new Date()) => {
  const cutoff = new Date(now);
  const dayOfMonth = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
  const lastDayOfMonth = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
  ).getUTCDate();
  cutoff.setUTCDate(Math.min(dayOfMonth, lastDayOfMonth));
  return cutoff;
};

const getAttachmentNames = (records) =>
  [
    ...new Set(
      records
        .flatMap((record) =>
          Array.isArray(record.attachments) ? record.attachments : [],
        )
        .map((attachment) =>
          typeof attachment?.name === "string" ? attachment.name.trim() : "",
        )
        .filter(Boolean),
    ),
  ];

const deletePatientAttachments = async (
  records,
  { deleteObject, unlinkFile },
) => {
  const attachments = records.flatMap((record) =>
    Array.isArray(record.attachments) ? record.attachments : [],
  );
  const names = getAttachmentNames(records);

  if (
    attachments.some(
      (attachment) =>
        typeof attachment?.name !== "string" || !attachment.name.trim(),
    )
  ) {
    console.error(
      "Some patient record attachments have no stored name and could not be cleaned up.",
    );
    void notifyAdminOperationalIssue("patient trash attachment cleanup");
  }

  for (const name of names) {
    try {
      await deleteObject(`records/${name}`);
    } catch (error) {
      console.error(
        "Failed to delete a patient record attachment from object storage:",
        error,
      );
      void notifyAdminOperationalIssue("patient trash attachment cleanup");
    }

    const filePath = path.join(
      process.cwd(),
      "uploads",
      "records",
      path.basename(name),
    );
    try {
      await unlinkFile(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(
          "Failed to delete a legacy patient record attachment:",
          error,
        );
        void notifyAdminOperationalIssue("patient trash attachment cleanup");
      }
    }
  }
};

export const deleteExpiredTrashedPatients = async ({
  now = new Date(),
  db = prisma,
  deleteObject = deleteObjectFromS3,
  unlinkFile = (filePath) => fs.promises.unlink(filePath),
} = {}) => {
  const cutoff = getTrashExpiryCutoff(now);
  const expiredPatients = await db.patient.findMany({
    where: {
      isDeleted: true,
      deletedAt: { lte: cutoff },
      invoices: { none: {} },
    },
    orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
    take: CLEANUP_BATCH_SIZE,
    select: {
      id: true,
      branchId: true,
      records: { select: { attachments: true } },
    },
  });

  let deletedCount = 0;
  for (const patient of expiredPatients) {
    try {
      const deleted = await db.$transaction(async (transaction) => {
        const invoice = await transaction.invoice.findFirst({
          where: { patientId: patient.id },
          select: { id: true },
        });
        if (invoice) return false;

        const result = await transaction.patient.deleteMany({
          where: {
            id: patient.id,
            isDeleted: true,
            deletedAt: { lte: cutoff },
          },
        });
        if (result.count !== 1) return false;

        await transaction.auditLog.create({
          data: {
            actorRole: "system",
            action: "patient.delete",
            resourceType: "patient",
            resourceId: patient.id,
            branchId: patient.branchId,
            metadata: {
              permanent: true,
              automatic: true,
              retentionMonths: RETENTION_MONTHS,
              reason: "Patient chart remained in Trash beyond its retention period",
            },
          },
        });

        return true;
      });

      if (!deleted) continue;
      deletedCount += 1;
      await deletePatientAttachments(patient.records, { deleteObject, unlinkFile });
    } catch (error) {
      console.error(
        "Failed to automatically delete an expired patient chart:",
        error,
      );
      void notifyAdminOperationalIssue("patient trash cleanup");
    }
  }

  if (deletedCount > 0) {
    console.log(
      `Automatically permanently deleted ${deletedCount} expired patient charts from Trash.`,
    );
  }

  return deletedCount;
};

const runCleanup = () => {
  if (cleanupRunPromise) return cleanupRunPromise;

  cleanupRunPromise = deleteExpiredTrashedPatients()
    .catch((error) => {
      console.error("Patient trash cleanup worker failed:", error);
      void notifyAdminOperationalIssue("patient trash cleanup");
    })
    .finally(() => {
      cleanupRunPromise = null;
    });

  return cleanupRunPromise;
};

export const startTrashCleanupWorker = () => {
  if (cleanupIntervalId) return;

  void runCleanup();
  cleanupIntervalId = setInterval(() => {
    void runCleanup();
  }, CLEANUP_INTERVAL_MS);
  cleanupIntervalId.unref();
  console.log("Patient trash cleanup worker started.");
};

export const stopTrashCleanupWorker = async () => {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  if (cleanupRunPromise) await cleanupRunPromise;
};
