import nodemailer from "nodemailer";
import twilio from "twilio";

// Load environment variables if not relying entirely on process.env
// In a real scenario, you'd pull these from process.env

const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. "whatsapp:+14155238886"

let twilioClient = null;
if (twilioAccountSid && twilioAuthToken) {
  try {
    twilioClient = twilio(twilioAccountSid, twilioAuthToken);
  } catch (err) {
    console.error("Twilio client init failed:", err.message);
  }
}

// Nodemailer transporter (Placeholder for testing if ENV is empty)
let transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.ethereal.email",
  port: process.env.SMTP_PORT || 587,
  auth: {
    user: process.env.SMTP_USER || "dummy_user",
    pass: process.env.SMTP_PASS || "dummy_pass",
  },
});

export const sendAppointmentReminder = async (patient, appointment, clinic) => {
  const appointmentTime = new Date(appointment.appointmentDate).toLocaleString();
  
  const defaultMessage = `Hello ${patient.name}, this is a reminder from ${clinic.name} for your scheduled appointment on ${appointmentTime}. Please reply to this message or contact us if you need to reschedule.`;

  // 1. Try sending WhatsApp via Twilio
  if (patient.phone && twilioClient && twilioWhatsAppNumber) {
    try {
      let formattedPhone = patient.phone;
      if (formattedPhone.startsWith("0")) {
        formattedPhone = "+234" + formattedPhone.slice(1);
      } else if (!formattedPhone.startsWith("+")) {
        formattedPhone = "+" + formattedPhone;
      }
      
      await twilioClient.messages.create({
        from: twilioWhatsAppNumber,
        to: `whatsapp:${formattedPhone}`,
        body: defaultMessage,
      });
      console.log(`[Notification Service] WhatsApp reminder sent to ${patient.name} (${formattedPhone})`);
    } catch (error) {
      console.error(`[Notification Service] Twilio error for ${patient.name}:`, error.message);
    }
  } else if (patient.phone) {
    console.log(`[Notification Service - MOCK MODE] WOULD HAVE SENT WHATSAPP TO: ${patient.phone}`);
    console.log(`[Notification Service - MOCK MODE] MSG: ${defaultMessage}`);
  }

  // 2. Try sending Email via Nodemailer
  if (patient.email) {
    try {
      if (!process.env.SMTP_HOST) {
        console.log(`[Notification Service - MOCK MODE] WOULD HAVE SENT EMAIL TO: ${patient.email}`);
        console.log(`[Notification Service - MOCK MODE] SUBJECT: Appointment Reminder from ${clinic.name}`);
        console.log(`[Notification Service - MOCK MODE] BODY: ${defaultMessage}`);
      } else {
        await transporter.sendMail({
          from: `"${clinic.name} Notifications" <${process.env.SMTP_USER}>`,
          to: patient.email,
          subject: `Appointment Reminder from ${clinic.name}`,
          text: defaultMessage,
        });
        console.log(`[Notification Service] Email reminder sent to ${patient.name} (${patient.email})`);
      }
    } catch (error) {
      console.error(`[Notification Service] Nodemailer error for ${patient.name}:`, error.message);
    }
  }
};
