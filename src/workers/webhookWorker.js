import { Queue, Worker, QueueScheduler } from "bullmq";
import IORedis from "ioredis";
import { prisma } from "../lib/prisma.js";
import { processPaystackWebhookEvent } from "../services/paystack.js";

const connection = new IORedis(
  process.env.REDIS_URL || "redis://127.0.0.1:6379",
);
const queueName = process.env.WEBHOOK_QUEUE_NAME || "billing-webhooks";

const queue = new Queue(queueName, { connection });
new QueueScheduler(queueName, { connection });

const worker = new Worker(
  queueName,
  async (job) => {
    const payload = job.data.payload;
    const webhookId = job.data.webhookId;

    try {
      await processPaystackWebhookEvent(payload);
      if (webhookId) {
        await prisma.billingWebhook.update({
          where: { id: webhookId },
          data: { processed: true, processedAt: new Date() },
        });
      }
      return { ok: true };
    } catch (err) {
      console.error("Webhook job failed:", err);
      if (webhookId) {
        await prisma.billingWebhook.update({
          where: { id: webhookId },
          data: {
            attempts: { increment: 1 },
            lastError: String(err?.message || err),
          },
        });
      }
      throw err;
    }
  },
  { connection, concurrency: 5 },
);

worker.on("failed", (job, err) => {
  console.error(`Job ${job.id} failed:`, err?.message || err);
});

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed.`);
});

export const enqueueWebhook = async (payload, webhookId = null) => {
  await queue.add(
    "process",
    { payload, webhookId },
    {
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 5,
      backoff: { type: "exponential", delay: 500 },
    },
  );
};

export default worker;
