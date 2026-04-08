import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import patientRoutes from "./routes/patient.routes.js";
import appointmentRoutes from "./routes/appointment.routes.js";
import waitingRoomRoutes from "./routes/waitingRoom.routes.js";
import invoiceRoutes from "./routes/invoice.routes.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { logger } from "./middleware/logger.js";

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN ||
  "http://localhost:5173,http://localhost:5174")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

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

app.use(express.json());
app.use(logger);
app.use("/api", apiLimiter);
app.use("/api/auth", authRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/waiting-room", waitingRoomRoutes);
app.use("/api/invoices", invoiceRoutes);

app.use((req, res) => {
  res.status(404).json({ message: "Endpoint not found" });
});

app.use((err, req, res, next) => {
  console.error(err.stack);

  const payload =
    process.env.NODE_ENV === "production"
      ? { message: "Server error" }
      : { message: "Server error", error: err.message };

  res.status(500).json(payload);
});

export default app;
