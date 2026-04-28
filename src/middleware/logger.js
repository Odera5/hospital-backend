import fs from "fs";
import path from "path";

const LOG_FILE = path.join(process.cwd(), "logs", "requests.log");
const shouldPersistLogs = process.env.NODE_ENV !== "production";

// Create logs folder if not exists
if (shouldPersistLogs && !fs.existsSync(path.dirname(LOG_FILE))) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

export const logger = (req, res, next) => {
  const log = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - ${req.ip}\n`;

  if (shouldPersistLogs) {
    fs.appendFile(LOG_FILE, log, (err) => {
      if (err) console.error("Failed to write log:", err);
    });
  }

  console.log(log.trim());

  next();
};
