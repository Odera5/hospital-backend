import { S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";

dotenv.config();

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
export const bucketName = process.env.R2_BUCKET_NAME;

if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
  console.warn("Missing Cloudflare R2 environment variables. File uploads to R2 might fail.");
}

export const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: accessKeyId || "",
    secretAccessKey: secretAccessKey || "",
  },
});

export const generatePresignedUrl = async (key) => {
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  });
  
  // URL expires in 15 minutes (900 seconds)
  return getSignedUrl(s3Client, command, { expiresIn: 900 });
};

export const deleteObjectFromS3 = async (key) => {
  const command = new DeleteObjectCommand({
    Bucket: bucketName,
    Key: key,
  });
  
  return s3Client.send(command);
};
