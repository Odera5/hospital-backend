import cron from "node-cron";
import { prisma } from "../lib/prisma.js";
import { sendAppointmentReminder } from "../services/notificationService.js";
import { toDecryptedPatient } from "../utils/patientCrypto.js";

// Run every hour at minute 0
cron.schedule("0 * * * *", async () => {
  console.log("[CRON] Running patient appointment reminder job...");
  
  try {
    const now = new Date();
    // 24 hours from now
    const next24HoursStart = new Date(now.getTime() + 23 * 60 * 60 * 1000); 
    const next24HoursEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Find appointments that match the 24 hour window
    const appointments = await prisma.appointment.findMany({
      where: {
        reminderSent: false,
        status: "scheduled",
        // appointmentDate: {
        //   gte: next24HoursStart,
        //   lte: next24HoursEnd,
        // },
        patient: {
          isDeleted: false,
          clinic: {
            // PRO plan required
            plan: "PRO",
          }
        }
      },
      include: {
        patient: {
          include: {
            clinic: true,
          }
        }
      }
    });

    if (appointments.length === 0) {
      console.log("[CRON] No reminders to send at this time.");
      return;
    }

    console.log(`[CRON] Found ${appointments.length} appointments needing reminders.`);

    for (const appointment of appointments) {
      try {
        const decryptedPatient = toDecryptedPatient(appointment.patient);
        const clinic = appointment.patient.clinic;

        // Dispatch notifications
        await sendAppointmentReminder(decryptedPatient, appointment, clinic);

        // Mark as sent
        await prisma.appointment.update({
          where: { id: appointment.id },
          data: { reminderSent: true }
        });
        
        console.log(`[CRON] Marked reminder as sent for appointment ${appointment.id}`);
      } catch (err) {
        console.error(`[CRON] Error sending reminder for appointment ${appointment.id}:`, err.message);
      }
    }
  } catch (error) {
    console.error(`[CRON] Fatal error in reminder job:`, error.message);
  }
});
