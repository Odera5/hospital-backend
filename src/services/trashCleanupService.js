import { prisma } from "../lib/prisma.js";

export const deleteExpiredTrashedPatients = async () => {
  try {
    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);

    const expiredPatients = await prisma.patient.findMany({
      where: {
        isDeleted: true,
        updatedAt: {
          lte: threeMinutesAgo,
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

      console.log(`Automatically permanently deleted ${result.count} patients from trash (older than 3 minutes).`);
    }
  } catch (error) {
    console.error("Failed to delete expired trashed patients:", error);
  }
};

let cleanupIntervalId = null;

export const startTrashCleanupWorker = () => {
  // Run once immediately on start
  deleteExpiredTrashedPatients();

  // Run every minute while testing the trash expiry window
  cleanupIntervalId = setInterval(() => {
    deleteExpiredTrashedPatients();
  }, 60 * 1000);

  console.log("Trash cleanup worker started.");
};


