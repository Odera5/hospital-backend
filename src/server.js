// src/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import connectDB from "./db.js";
import authRoutes from "./routes/auth.routes.js";
import patientRoutes from "./routes/patient.routes.js";
import appointmentRoutes from "./routes/appointment.routes.js";
import waitingRoomRoutes from "./routes/waitingRoom.routes.js";
import invoiceRoutes from "./routes/invoice.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import intakeRoutes from "./routes/intake.routes.js";
import billingRoutes from "./routes/billing.routes.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { logger } from "./middleware/logger.js";
import { handlePaystackWebhook } from "./controllers/billingController.js";
import path from "path";
import fs from "fs";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
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

// =========================
// MIDDLEWARE
// =========================
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

app.post(
  "/api/billing/paystack/webhook",
  express.raw({ type: "application/json" }),
  handlePaystackWebhook,
);

app.use(express.json());
app.use(logger);
app.use("/api", apiLimiter); // make sure apiLimiter calls next()
// =========================
// STATIC DIRECTORIES & FILE PROXIES
// =========================

// Proxy branding images from Cloudflare R2
app.get("/uploads/branding/:filename", async (req, res) => {
  try {
    const { s3Client, bucketName } = await import("./lib/s3.js");
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    
    if (!bucketName) throw new Error("R2 not configured");
    
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: `branding/${req.params.filename}`,
    });
    
    const s3Response = await s3Client.send(command);
    res.set("Content-Type", s3Response.ContentType);
    s3Response.Body.pipe(res);
  } catch (error) {
    // Fallback to local files if S3 fails or file is not in S3 (e.g., old files before migration)
    const localPath = path.join(process.cwd(), "uploads", "public", "branding", req.params.filename);
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

// =========================
// ROUTES
// =========================
app.use("/api/auth", authRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/waiting-room", waitingRoomRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/intake", intakeRoutes);
app.use("/api/billing", billingRoutes);

// =========================
// 404 HANDLER
// =========================
app.use((req, res, next) => {
  res.status(404).json({ message: "Endpoint not found" });
});

// =========================
// GLOBAL ERROR HANDLER
// =========================
app.use((err, req, res, next) => {
  console.error(err.stack);

  const payload =
    process.env.NODE_ENV === "production"
      ? { message: "Server error" }
      : { message: "Server error", error: err.message };

  res.status(500).json(payload);
});

// =========================
// START SERVER
// =========================
const startServer = async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
  }
};

startServer();


