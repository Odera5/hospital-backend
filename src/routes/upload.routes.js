import express from "express";
import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import { verifyToken } from "../middleware/auth.js";
import { requireProOrEnterprise } from "../middleware/subscriptionGuard.js";
import { s3Client, bucketName } from "../lib/s3.js";

const router = express.Router();

const extMap = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};
const allowedMimeTypes = new Set(Object.keys(extMap));
const allowedExtensions = new Set(Object.values(extMap));

const storage = multerS3({
  s3: s3Client,
  bucket: bucketName,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    let ext = path.extname(file.originalname);
    if (!ext && extMap[file.mimetype]) {
      ext = extMap[file.mimetype];
    }
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    cb(null, `branding/${uniqueSuffix}${ext ? "" : "-" + safeName}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const originalExtension = path.extname(String(file.originalname || "")).toLowerCase();
  const derivedExtension =
    originalExtension || extMap[String(file.mimetype || "")] || "";
  const hasAllowedMimeType = allowedMimeTypes.has(String(file.mimetype || ""));
  const hasAllowedExtension = allowedExtensions.has(derivedExtension);

  if (hasAllowedMimeType && hasAllowedExtension) {
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

    const filename = path.basename(req.file.key);
    const fileUrl = `/uploads/branding/${filename}`;
    
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
