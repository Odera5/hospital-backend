import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import authRoutes from "./routes/auth.routes.js";
import patientRoutes from "./routes/patient.routes.js";
import appointmentRoutes from "./routes/appointment.routes.js";
import waitingRoomRoutes from "./routes/waitingRoom.routes.js";
import invoiceRoutes from "./routes/invoice.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import intakeRoutes from "./routes/intake.routes.js";
import pendingIntakesRoutes from "./routes/pendingIntakes.routes.js";
import billingRoutes from "./routes/billing.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { logger } from "./middleware/logger.js";
import { handlePaystackWebhook } from "./controllers/billingController.js";
import { prisma } from "./lib/prisma.js";

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN ||
  "http://localhost:5173,http://localhost:5174")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "ENCRYPTION_KEY",
];

const missingEnvVars = REQUIRED_ENV_VARS.filter(
  (name) => !process.env[name]?.trim(),
);

if (missingEnvVars.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingEnvVars.join(", ")}`,
  );
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  }),
);

app.post(
  "/api/billing/paystack/webhook",
  express.raw({ type: "application/json" }),
  handlePaystackWebhook,
);

app.use(express.json({ limit: "1mb" }));
app.use(logger);
app.use("/api", apiLimiter);

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/ready", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      status: "ready",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: "not_ready",
      timestamp: new Date().toISOString(),
    });
  }
});

app.get("/uploads/branding/:filename", async (req, res) => {
  try {
    const { s3Client, bucketName } = await import("./lib/s3.js");
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");

    if (!bucketName) throw new Error("R2 not configured");

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: `branding/${path.basename(req.params.filename)}`,
    });

    const s3Response = await s3Client.send(command);
    res.set("Content-Type", s3Response.ContentType);
    s3Response.Body.pipe(res);
  } catch (error) {
    const localPath = path.join(
      process.cwd(),
      "uploads",
      "public",
      "branding",
      path.basename(req.params.filename),
    );
    if (fs.existsSync(localPath)) {
      return res.sendFile(localPath);
    }
    res.status(404).json({ message: "File not found" });
  }
});

app.use(
  "/uploads",
  express.static(path.join(process.cwd(), "uploads", "public")),
);

app.use("/api/auth", authRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/waiting-room", waitingRoomRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/intake", intakeRoutes);
app.use("/api/pending-intakes", pendingIntakesRoutes);
app.use("/api/billing", billingRoutes);

app.use((req, res) => {
  res.status(404).json({ message: "Endpoint not found" });
});

app.use((err, req, res, next) => {
  console.error(err.stack);

  if (err?.type === "entity.too.large") {
    return res.status(413).json({ message: "Request payload is too large" });
  }

  if (err?.name === "MulterError") {
    return res.status(400).json({ message: err.message });
  }

  if (err?.message?.startsWith("CORS blocked for origin:")) {
    return res.status(403).json({ message: "Origin is not allowed" });
  }

  const payload =
    process.env.NODE_ENV === "production"
      ? { message: "Server error" }
      : { message: "Server error", error: err.message };

  res.status(500).json(payload);
});

export default app;
