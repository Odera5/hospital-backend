import dotenv from "dotenv";
import connectDB from "./db.js";
import { startAppointmentReminderWorker } from "./services/appointmentReminderService.js";
import { ensurePatientSearchIndexesBackfilled } from "./services/patientSearchIndex.js";
import { prisma } from "./lib/prisma.js";
import app from "./app.js";

dotenv.config();

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
    server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
    startAppointmentReminderWorker();
    ensurePatientSearchIndexesBackfilled();
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


