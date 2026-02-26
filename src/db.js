// src/db.js
import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI; // from Render environment variables

const connectDB = async () => {
  try {
    await mongoose.connect(MONGO_URI); // simple, clean connection
    console.log("MongoDB connected successfully!");
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    process.exit(1); // stop server if DB fails
  }
};

export default connectDB;
