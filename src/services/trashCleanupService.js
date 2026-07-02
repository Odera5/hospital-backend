import { prisma } from "../lib/prisma.js";

export const deleteExpiredTrashedPatients = async () => {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const expiredPatients = await prisma.patient.findMany({
      where: {
        isDeleted: true,
        updatedAt: {
          lte: sixMonthsAgo,
        },
      },
      select: {
        id: true,
      },
    });

    if (expiredPatients.length > 0) {
      const expiredIds = expiredPatients.map((p) => p.id);

      const result = await prisma.patient.deleteMany({
        where: {
          id: {
            in: expiredIds,
          },
        },
      });

      console.log(`Automatically permanently deleted ${result.count} patients from trash (older than 6 months).`);
    }
  } catch (error) {
    console.error("Failed to delete expired trashed patients:", error);
  }
};

let cleanupIntervalId = null;

export const startTrashCleanupWorker = () => {
  // Run once immediately on start
  deleteExpiredTrashedPatients();

  // Run every 12 hours (12 * 60 * 60 * 1000 ms)
  cleanupIntervalId = setInterval(() => {
    deleteExpiredTrashedPatients();
  }, 12 * 60 * 60 * 1000);

  console.log("Trash cleanup worker started.");
};


