import multer from "multer";
import path from "path";

// Set storage engine
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/records"); // saves to backend/uploads/records
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + "-" + uniqueSuffix + ext);
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

const upload = multer({ storage, fileFilter });

export default upload;