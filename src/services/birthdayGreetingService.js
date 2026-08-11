import { prisma } from "../lib/prisma.js";
import { toDecryptedPatient } from "../utils/patientCrypto.js";
import { sendBirthdayGreetingEmail } from "./emailVerification.js";

export const sendDailyBirthdayGreetings = async () => {
  try {
    const today = new Date();
    const currentYear = today.getFullYear();
    const curMonth = String(today.getMonth() + 1).padStart(2, "0");
    const curDay = String(today.getDate()).padStart(2, "0");

    console.log(`[Birthday Worker] Starting daily check for birthdays matching ${curMonth}-${curDay}...`);

    // Retrieve all active patients who haven't received a greeting this year
    const patients = await prisma.patient.findMany({
      where: {
        isDeleted: false,
        OR: [
          { lastBirthdayGreetingYear: null },
          { lastBirthdayGreetingYear: { lt: currentYear } },
        ],
      },
      include: {
        clinic: {
          select: {
            name: true,
          },
        },
      },
    });

    let sentCount = 0;

    for (const patient of patients) {
      try {
        const decrypted = toDecryptedPatient(patient);
        const dob = decrypted.dateOfBirth; // format: YYYY-MM-DD

        if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
          continue;
        }

        const [, birthMonth, birthDay] = dob.split("-");

        if (birthMonth === curMonth && birthDay === curDay) {
          console.log(`[Birthday Worker] Found birthday match: ${decrypted.name} (${decrypted.email})`);

          // Only send if the patient has a valid email address
          if (decrypted.email && decrypted.email.includes("@")) {
            await sendBirthdayGreetingEmail({
              email: decrypted.email,
              name: decrypted.name,
              clinicName: patient.clinic?.name || "CareChrome",
            });
            sentCount++;
          }

          // Mark as sent for this year to prevent duplicates
          await prisma.patient.update({
            where: { id: patient.id },
            data: {
              lastBirthdayGreetingYear: currentYear,
            },
          });
        }
      } catch (patientError) {
        console.error(`[Birthday Worker] Failed processing patient ${patient.id}:`, patientError);
      }
    }

    console.log(`[Birthday Worker] Finished daily check. Sent ${sentCount} birthday greeting(s).`);
  } catch (error) {
    console.error("[Birthday Worker] Failed to run daily birthday greetings:", error);
  }
};

let workerIntervalId = null;

export const startBirthdayGreetingWorker = () => {
  // Run once immediately on start
  sendDailyBirthdayGreetings();

  // Run every 24 hours (24 * 60 * 60 * 1000 ms)
  workerIntervalId = setInterval(() => {
    sendDailyBirthdayGreetings();
  }, 24 * 60 * 60 * 1000);

  console.log("Birthday greeting worker started.");
};
