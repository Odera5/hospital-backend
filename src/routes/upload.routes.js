import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { verifyToken } from "../middleware/auth.js";
import { requireProOrEnterprise } from "../middleware/subscriptionGuard.js";

const router = express.Router();

// Ensure uploads directory exists
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Map MIME types to extensions to handle blobs gracefully
const extMap = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Generate a unique filename: <timestamp>-<originalName>
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    // If the file comes via Blob/FormData without extension, append it from mimetype
    let ext = path.extname(file.originalname);
    if (!ext && extMap[file.mimetype]) {
      ext = extMap[file.mimetype];
    }
    // Clean original name to prevent weird characters
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    cb(null, `${uniqueSuffix}${ext ? "" : "-" + safeName}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type. Only JPG, PNG, WEBP, and PDF are allowed."), false);
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: fileFilter,
});

/**
 * @route   POST /api/upload
 * @desc    Upload a file (Pro Plan feature)
 * @access  Private
 */
router.post("/", verifyToken, requireProOrEnterprise, upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded." });
    }

    // The frontend will access this via /uploads/<filename>
    const fileUrl = `/uploads/${req.file.filename}`;
    
    res.status(200).json({
      message: "File uploaded successfully",
      url: fileUrl,
      fileName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ message: "Failed to process upload." });
  }
});

export default router;
