import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import { s3Client, bucketName } from "../lib/s3.js";

// Set storage engine to Cloudflare R2 via S3 API
const storage = multerS3({
  s3: s3Client,
  bucket: bucketName,
  acl: 'private', // Keep patient records private
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `records/${file.fieldname}-${uniqueSuffix}${ext}`);
  },
});

// File filter (optional)
const fileFilter = (req, file, cb) => {
  // Allow only certain file types
  const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx/;
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedTypes.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error("File type not allowed"));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5,
  },
});

export default upload;
