import fs from "fs";
import path from "path";

const LOG_FILE = path.join(process.cwd(), "logs", "requests.log");

// Create logs folder if not exists
if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE));

export const logger = (req, res, next) => {
  const log = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - ${req.ip}\n`;
  
  // Append to file
  fs.appendFile(LOG_FILE, log, (err) => {
    if (err) console.error("Failed to write log:", err);
  });

  // Also log to console
  console.log(log.trim());

  next();
};
