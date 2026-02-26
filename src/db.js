// db.js
import mongoose from "mongoose";

const MONGO_URI = "mongodb://localhost:27017/BHF"; // your MongoDB URI

const connectDB = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("MongoDB connected successfully!");
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    process.exit(1); // stop server if DB fails
  }
};

export default connectDB;
