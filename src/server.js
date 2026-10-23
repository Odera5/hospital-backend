import "dotenv/config";
import connectDB from "./db.js";
import {
  startAppointmentReminderWorker,
  stopAppointmentReminderWorker,
} from "./services/appointmentReminderService.js";
import { ensurePatientSearchIndexesBackfilled } from "./services/patientSearchIndex.js";
import { startTrashCleanupWorker } from "./services/trashCleanupService.js";
import { startBirthdayGreetingWorker } from "./services/birthdayGreetingService.js";
import { prisma } from "./lib/prisma.js";
import {
  startRateLimitCleanup,
  stopRateLimitCleanup,
} from "./middleware/rateLimit.js";
import app from "./app.js";

const PORT = process.env.PORT || 5000;
let server;
let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`${signal} received. Shutting down gracefully...`);

  try {
    stopRateLimitCleanup();
    await stopAppointmentReminderWorker();

    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }

    await prisma.$disconnect();
    console.log("Shutdown complete.");
    process.exit(0);
  } catch (error) {
    console.error("Graceful shutdown failed:", error);
    process.exit(1);
  }
};

const startServer = async () => {
  try {
    await connectDB();
    startRateLimitCleanup();
    server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
    startAppointmentReminderWorker();
    ensurePatientSearchIndexesBackfilled();
    startTrashCleanupWorker();
    startBirthdayGreetingWorker();
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
};

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

startServer();
