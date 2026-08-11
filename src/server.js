import dotenv from "dotenv";
import { execSync } from "child_process";
import connectDB from "./db.js";
import { startAppointmentReminderWorker } from "./services/appointmentReminderService.js";
import { ensurePatientSearchIndexesBackfilled } from "./services/patientSearchIndex.js";
import { startTrashCleanupWorker } from "./services/trashCleanupService.js";
import { startBirthdayGreetingWorker } from "./services/birthdayGreetingService.js";
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

const runMigrations = () => {
  console.log("Running pending database migrations...");
  try {
    const output = execSync("npx prisma migrate deploy", { stdio: "pipe" });
    console.log("Migration output:", output.toString());
    console.log("Database migrations applied successfully.");
  } catch (error) {
    console.error("Failed to run migrations:", error.message);
    if (error.stdout) console.error("Migration stdout:", error.stdout.toString());
    if (error.stderr) console.error("Migration stderr:", error.stderr.toString());
    throw error;
  }
};

const startServer = async () => {
  try {
    runMigrations();
    await connectDB();
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


