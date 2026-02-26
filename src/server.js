// src/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import connectDB from "./db.js";
import authRoutes from "./routes/auth.routes.js";
import patientRoutes from "./routes/patient.routes.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { logger } from "./middleware/logger.js";
import Patient from "./models/patient.model.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// =========================
// MIDDLEWARE
// =========================
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);

app.use(express.json());
app.use(logger);
app.use("/api", apiLimiter); // make sure apiLimiter calls next()

// =========================
// ROUTES
// =========================
app.use("/api/auth", authRoutes);
app.use("/api/patients", patientRoutes);

// =========================
// TRASH PATIENTS ROUTES
// =========================
app.get("/api/patients/trash/all", async (req, res) => {
  try {
    const trashedPatients = await Patient.find({ isDeleted: true });
    res.json(trashedPatients);
  } catch (err) {
    console.error("Error fetching trashed patients:", err);
    res.status(500).json({ message: "Server error fetching trashed patients" });
  }
});

app.put("/api/patients/restore", async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) {
    return res.status(400).json({ message: "Provide an array of ids" });
  }

  try {
    await Patient.updateMany({ _id: { $in: ids } }, { isDeleted: false });
    res.json({ message: "Patients restored successfully" });
  } catch (err) {
    console.error("Error restoring patients:", err);
    res.status(500).json({ message: "Server error restoring patients" });
  }
});

app.delete("/api/patients/permanent", async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) {
    return res.status(400).json({ message: "Provide an array of ids" });
  }

  try {
    await Patient.deleteMany({ _id: { $in: ids } });
    res.json({ message: "Patients permanently deleted" });
  } catch (err) {
    console.error("Error deleting patients:", err);
    res.status(500).json({ message: "Server error deleting patients" });
  }
});

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
  res.status(500).json({ message: "Server error", error: err.message });
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