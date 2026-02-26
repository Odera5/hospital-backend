import fs from "fs";
import crypto from "crypto";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const ENCRYPTION_KEY = process.env.FILE_ENCRYPTION_KEY || "32charslongsecretkey1234567890"; // 32 chars
const IV_LENGTH = 16;

// Encrypt a file
export const encryptFile = (filePath) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY), iv);
  const input = fs.createReadStream(filePath);
  const output = fs.createWriteStream(filePath + ".enc");

  return new Promise((resolve, reject) => {
    input.pipe(cipher).pipe(output);
    output.on("finish", () => {
      fs.unlinkSync(filePath); // delete original unencrypted file
      resolve(filePath + ".enc");
    });
    output.on("error", reject);
  });
};

// Decrypt a file
export const decryptFile = (encryptedPath, outputPath) => {
  const input = fs.createReadStream(encryptedPath);

  const ivBuffer = Buffer.alloc(IV_LENGTH); // You can store IV in file header in production
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY), ivBuffer);

  const output = fs.createWriteStream(outputPath);
  return new Promise((resolve, reject) => {
    input.pipe(decipher).pipe(output);
    output.on("finish", resolve);
    output.on("error", reject);
  });
};
