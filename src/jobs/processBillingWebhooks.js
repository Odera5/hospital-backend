#!/usr/bin/env node
import { prisma } from "../lib/prisma.js";
import { processPaystackWebhookEvent } from "../services/paystack.js";
import { fileURLToPath } from "url";

const BATCH_SIZE = Number(process.env.WEBHOOK_BATCH_SIZE || 20);

async function processBatch() {
  const items = await prisma.billingWebhook.findMany({
    where: { processed: false },
    take: BATCH_SIZE,
    orderBy: { receivedAt: "asc" },
  });

  if (!items.length) {
    console.log("No unprocessed billing webhooks found.");
    return;
  }

  for (const item of items) {
    try {
      console.log(`Processing webhook ${item.id} (attempts=${item.attempts})`);
      await processPaystackWebhookEvent(item.payload);

      await prisma.billingWebhook.update({
        where: { id: item.id },
        data: {
          processed: true,
          processedAt: new Date(),
        },
      });

      console.log(`Webhook ${item.id} processed successfully.`);
    } catch (err) {
      console.error(
        `Failed processing webhook ${item.id}:`,
        err?.message || err,
      );
      try {
        await prisma.billingWebhook.update({
          where: { id: item.id },
          data: {
            attempts: (item.attempts || 0) + 1,
            lastError: String(err?.message || err),
          },
        });
      } catch (uerr) {
        console.error(
          `Failed to update webhook failure state for ${item.id}:`,
          uerr?.message || uerr,
        );
      }
    }
  }
}

const entrypoint = process.argv[1] === fileURLToPath(import.meta.url);

if (entrypoint) {
  (async () => {
    try {
      await processBatch();
      console.log("Finished processing billing webhooks.");
      process.exit(0);
    } catch (err) {
      console.error("Webhook processor error:", err);
      process.exit(1);
    }
  })();
}

export default processBatch;
