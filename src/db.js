// src/db.js
import mongoose from "mongoose";

// Use environment variable for MongoDB URI
const MONGO_URI = process.env.MONGO_URI;

const connectDB = async () => {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("MongoDB connected successfully!");
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    process.exit(1); // stop server if DB fails
  }
};

export default connectDB;