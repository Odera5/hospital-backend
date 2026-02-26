import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";

import authRoutes from "./routes/auth.routes.js";
import patientRoutes from "./routes/patient.routes.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// Make uploads folder publicly accessible
app.use("/uploads", express.static(path.join(path.resolve(), "uploads")));

// MongoDB connection
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/patients", patientRoutes);

export default app;
