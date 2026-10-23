import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.routes.js";
import patientRoutes from "./routes/patient.routes.js";
import appointmentRoutes from "./routes/appointment.routes.js";
import waitingRoomRoutes from "./routes/waitingRoom.routes.js";
import invoiceRoutes from "./routes/invoice.routes.js";
import cashReconciliationRoutes from "./routes/cashReconciliation.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import intakeRoutes from "./routes/intake.routes.js";
import pendingIntakesRoutes from "./routes/pendingIntakes.routes.js";
import billingRoutes from "./routes/billing.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import branchRoutes from "./routes/branch.routes.js";
import auditLogRoutes from "./routes/auditLog.routes.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { logger } from "./middleware/logger.js";
import { handlePaystackWebhook } from "./controllers/billingController.js";
import { prisma } from "./lib/prisma.js";

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const isRender = process.env.RENDER === "true";
const shouldTrustProxy = String(process.env.TRUST_PROXY || "")
  .trim()
  .toLowerCase();
if (isProduction || isRender || shouldTrustProxy === "true") {
  app.set("trust proxy", 1);
}

const allowedOrigins = (
  process.env.CORS_ORIGIN || "http://localhost:5173,http://localhost:5174"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "ENCRYPTION_KEY",
];
const REQUIRED_PRODUCTION_ENV_VARS = [
  "CORS_ORIGIN",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "CLOUDFLARE_TURNSTILE_SECRET_KEY",
];

const requiredEnvVars = [
  ...REQUIRED_ENV_VARS,
  ...(isProduction ? REQUIRED_PRODUCTION_ENV_VARS : []),
];
const missingEnvVars = requiredEnvVars.filter(
  (name) => !process.env[name]?.trim(),
);
if (
  isProduction &&
  !process.env.APP_BASE_URL?.trim() &&
  !process.env.FRONTEND_URL?.trim()
) {
  missingEnvVars.push("APP_BASE_URL (or FRONTEND_URL)");
}

if (missingEnvVars.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingEnvVars.join(", ")}`,
  );
}

if (
  isProduction &&
  process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY ===
    "1x0000000000000000000000000000000AA"
) {
  throw new Error(
    "A production Cloudflare Turnstile secret must replace the test secret.",
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
app.use(cookieParser());
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
app.use("/api/cash-reconciliations", cashReconciliationRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/branches", branchRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/intake", intakeRoutes);
app.use("/api/pending-intakes", pendingIntakesRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/audit-logs", auditLogRoutes);

app.use((req, res) => {
  res.status(404).json({ message: "Endpoint not found" });
});

app.use((err, req, res, next) => {
  console.error(err);

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
      : {
          message: "Server error",
          error: err?.message || String(err),
          ...(err?.stack ? { stack: err.stack } : {}),
        };

  res.status(500).json(payload);
});

export default app;
