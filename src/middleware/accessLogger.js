import fs from "fs";
import path from "path";

const LOG_FILE = path.join(process.cwd(), "logs", "access.log");
if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE));

export const logAccess = (userId, action, patientId) => {
  const log = `[${new Date().toISOString()}] User ${userId} ${action} Patient ${patientId}\n`;
  fs.appendFile(LOG_FILE, log, (err) => {
    if (err) console.error("Failed to log access:", err);
  });
};
