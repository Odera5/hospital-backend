import { prisma } from "../lib/prisma.js";
import { toDecryptedPatient } from "../utils/patientCrypto.js";
import {
  hasReminderAccess,
  getReminderAccessRequiredMessage,
} from "../utils/subscriptionAccess.js";

const RESEND_API_URL = "https://api.resend.com/emails";
const TWILIO_API_BASE_URL = "https://api.twilio.com/2010-04-01";
const REMINDER_POLL_INTERVAL_MS = 5 * 60 * 1000;

let transporterPromise = null;
let reminderIntervalId = null;
let reminderJobRunning = false;

const isResendConfigured = () =>
  Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim());

const isMailConfigured = () =>
  Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_PORT?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim() &&
      process.env.SMTP_FROM_EMAIL?.trim(),
  );

const isEmailConfigured = () => isResendConfigured() || isMailConfigured();

const isSmsConfigured = () =>
  Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
      process.env.TWILIO_AUTH_TOKEN?.trim() &&
      (process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() ||
        process.env.TWILIO_PHONE_NUMBER?.trim()),
  );

const hasReminderDeliveryConfigured = () =>
  isEmailConfigured() || isSmsConfigured();

const getReminderDeliveryUnavailableError = ({
  hasEmail,
  hasPhone,
  hasValidPhone,
}) => {
  if (isEmailConfigured() && isSmsConfigured()) {
    if (!hasEmail && !hasPhone) {
      return {
        status: "no_contact",
        message:
          "Patient phone number or email is required for automated reminders.",
      };
    }

    if (!hasEmail && hasPhone && !hasValidPhone) {
      return {
        status: "invalid_phone",
        message:
          "Patient phone number must be in international format, for example +2348012345678.",
      };
    }

    return {
      status: "delivery_unavailable",
      message: "No configured reminder channel is available for this patient.",
    };
  }

  if (isEmailConfigured()) {
    return {
      status: "no_email",
      message: "Patient email is required for automated reminders.",
    };
  }

  if (isSmsConfigured()) {
    if (!hasPhone) {
      return {
        status: "no_phone",
        message: "Patient phone number is required for automated reminders.",
      };
    }

    if (!hasValidPhone) {
      return {
        status: "invalid_phone",
        message:
          "Patient phone number must be in international format, for example +2348012345678.",
      };
    }
  }

  return {
    status: "delivery_unavailable",
    message: "Reminder delivery is not configured yet.",
  };
};

const getSenderEmail = () =>
  process.env.EMAIL_FROM?.trim() || process.env.SMTP_FROM_EMAIL?.trim() || "";

const getBaseUrl = () =>
  process.env.APP_BASE_URL?.trim() ||
  process.env.FRONTEND_URL?.trim() ||
  process.env.CORS_ORIGIN?.split(",")[0]?.trim() ||
  "http://localhost:5173";

const getTransporter = async () => {
  if (!isMailConfigured()) {
    throw new Error(
      "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM_EMAIL.",
    );
  }

  if (!transporterPromise) {
    transporterPromise = import("nodemailer").then(({ default: nodemailer }) =>
      nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      }),
    );
  }

  return transporterPromise;
};

const getAppointmentStartDateTime = (appointmentDate, timeSlot) => {
  const baseDate = new Date(appointmentDate);
  if (Number.isNaN(baseDate.getTime())) return null;

  const [hours, minutes] = String(timeSlot || "")
    .split(":")
    .map((value) => Number(value));

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }

  baseDate.setHours(hours, minutes, 0, 0);
  return baseDate;
};

const isLikelyE164PhoneNumber = (value) =>
  /^\+[1-9]\d{7,14}$/.test(String(value || "").trim());

const buildReminderLinks = (responseToken) => {
  const baseUrl = getBaseUrl().replace(/\/$/, "");
  const encodedToken = encodeURIComponent(responseToken);

  return {
    confirmUrl: `${baseUrl}/appointment-response?token=${encodedToken}&action=confirm`,
    rescheduleUrl: `${baseUrl}/appointment-response?token=${encodedToken}&action=reschedule`,
  };
};

const getTimeText = (minutes) => {
  if (minutes < 60) return `in ${minutes} minutes`;
  if (minutes < 1440) return `in ${Math.round(minutes / 60)} hours`;
  return `in ${Math.round(minutes / 1440)} days`;
};

const buildReminderEmailCopy = ({
  patientName,
  clinicName,
  appointmentDate,
  timeSlot,
  type,
  responseToken,
}) => {
  const formattedDate = appointmentDate.toLocaleDateString("en-NG", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  
  const timeText = getTimeText(Number(type));
  const title = `Appointment Reminder: Coming up ${timeText}`;
  const intro = `This is a friendly reminder that you have an appointment coming up ${timeText}.`;
  
  const { confirmUrl, rescheduleUrl } = buildReminderLinks(responseToken);

  return {
    subject: `${clinicName || "Your clinic"} Appointment Reminder`,
    text: [
      `Hello ${patientName || "there"},`,
      "",
      intro,
      "",
      `Clinic: ${clinicName || "Your clinic"}`,
      `Date: ${formattedDate}`,
      `Time: ${timeSlot}`,
      "",
      `Confirm: ${confirmUrl}`,
      `Request reschedule: ${rescheduleUrl}`,
      "",
      "If you need to reschedule, please contact the clinic as soon as possible.",
    ].join("\n"),
    html: `
      <div style="font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; padding: 32px 16px;">
        <div style="max-width: 560px; margin: 0 auto; background-color: #ffffff; border-radius: 18px; padding: 40px 32px; border: 1px solid #e2e8f0; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);">
          <p style="margin: 0 0 10px; color: #0f766e; font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase;">Appointment Reminder</p>
          <h1 style="margin: 0 0 16px; color: #0f172a; font-size: 26px; line-height: 1.2;">${title}</h1>
          <p style="margin: 0 0 24px; color: #475569; font-size: 16px; line-height: 1.6;">
            Hello ${patientName || "there"},<br /><br />
            ${intro}
          </p>
          <div style="background: linear-gradient(135deg, #ecfeff, #f8fafc); border: 1px solid #bae6fd; border-radius: 16px; padding: 20px 22px; margin-bottom: 24px;">
            <p style="margin: 0 0 8px; color: #0f172a; font-size: 15px;"><strong>Clinic:</strong> ${clinicName || "Your clinic"}</p>
            <p style="margin: 0 0 8px; color: #0f172a; font-size: 15px;"><strong>Date:</strong> ${formattedDate}</p>
            <p style="margin: 0; color: #0f172a; font-size: 15px;"><strong>Time:</strong> ${timeSlot}</p>
          </div>
          <div style="margin-bottom: 24px; display: flex; flex-wrap: wrap; gap: 12px;">
            <a href="${confirmUrl}" style="display: inline-block; background-color: #0f766e; color: #ffffff; text-decoration: none; padding: 14px 22px; border-radius: 12px; font-weight: 700; font-size: 14px;">
              Confirm Appointment
            </a>
            <a href="${rescheduleUrl}" style="display: inline-block; background-color: #fff7ed; color: #c2410c; text-decoration: none; padding: 14px 22px; border-radius: 12px; font-weight: 700; font-size: 14px; border: 1px solid #fdba74;">
              Request Reschedule
            </a>
          </div>
          <p style="margin: 0; color: #64748b; font-size: 14px; line-height: 1.6;">
            If you need to reschedule, please contact the clinic as soon as possible.
          </p>
        </div>
      </div>
    `,
  };
};

const buildReminderSmsCopy = ({
  patientName,
  clinicName,
  appointmentDate,
  timeSlot,
  type,
  responseToken,
}) => {
  const formattedDate = appointmentDate.toLocaleDateString("en-NG", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  
  const timeText = getTimeText(Number(type));
  const intro = `Appointment reminder: your visit is coming up ${timeText}.`;
  
  const { confirmUrl, rescheduleUrl } = buildReminderLinks(responseToken);

  return [
    `${clinicName || "Your clinic"}: ${intro}`,
    `Patient: ${patientName || "there"}`,
    `Date: ${formattedDate}`,
    `Time: ${timeSlot}`,
    `Confirm: ${confirmUrl}`,
    `Reschedule: ${rescheduleUrl}`,
  ].join("\n");
};

const sendReminderEmail = async ({
  email,
  patientName,
  clinicName,
  appointmentDate,
  timeSlot,
  type,
  responseToken,
}) => {
  const { subject, text, html } = buildReminderEmailCopy({
    patientName,
    clinicName,
    appointmentDate,
    timeSlot,
    type,
    responseToken,
  });

  if (isResendConfigured()) {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `PrimuxCare <${getSenderEmail()}>`,
        to: [email],
        subject,
        text,
        html,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Resend API error: ${response.status} ${errorText}`);
    }

    return;
  }

  const transporter = await getTransporter();
  await transporter.sendMail({
    from: `"PrimuxCare" <${getSenderEmail()}>`,
    to: email,
    subject,
    text,
    html,
  });
};

const sendReminderSms = async ({
  phone,
  patientName,
  clinicName,
  appointmentDate,
  timeSlot,
  type,
  responseToken,
}) => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const messagingServiceSid =
    process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || "";
  const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER?.trim() || "";

  if (!accountSid || !authToken) {
    throw new Error(
      "Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.",
    );
  }

  if (!messagingServiceSid && !twilioPhoneNumber) {
    throw new Error(
      "Twilio sender is not configured. Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER.",
    );
  }

  const body = new URLSearchParams({
    To: phone,
    Body: buildReminderSmsCopy({
      patientName,
      clinicName,
      appointmentDate,
      timeSlot,
      type,
      responseToken,
    }),
  });

  if (messagingServiceSid) {
    body.set("MessagingServiceSid", messagingServiceSid);
  } else {
    body.set("From", twilioPhoneNumber);
  }

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString(
    "base64",
  );
  const response = await fetch(
    `${TWILIO_API_BASE_URL}/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Twilio API error: ${response.status} ${errorText}`);
  }
};

const markReminderFailure = async (appointmentId, errorMessage) => {
  await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      reminderStatus: "failed",
      reminderLastError: String(errorMessage || "Reminder delivery failed").slice(
        0,
        500,
      ),
    },
  });
};

const markReminderDisabled = async (
  appointmentId,
  reminderStatus,
  reminderLastError = "",
) => {
  await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      reminderEnabled: false,
      reminderStatus,
      reminderLastError,
    },
  });
};

const markReminderSent = async (appointmentId, type, reminderLastError = "") => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { remindersSent: true }
  });
  
  const sent = Array.isArray(appointment?.remindersSent) ? appointment.remindersSent : [];
  sent.push(Number(type));

  await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      reminderStatus: "sent",
      remindersSent: sent,
      reminderLastSentAt: new Date(),
      reminderLastError: String(reminderLastError || "").slice(0, 500),
    },
  });
};

export const processAppointmentReminders = async () => {
  if (reminderJobRunning || !hasReminderDeliveryConfigured()) {
    return;
  }

  reminderJobRunning = true;

  try {
    const now = new Date();
    // Look ahead generously. We no longer use 26 hours strictly, as they might have a 48h offset.
    // However, fetching all future appointments is fine if the DB is indexed.
    // To be safe, let's fetch any scheduled appointments with reminderEnabled=true.
    const appointments = await prisma.appointment.findMany({
      where: {
        status: "scheduled",
        OR: [
          {
            reminderEnabled: true,
            appointmentDate: {
              gte: new Date(now.getTime() - 24 * 60 * 60 * 1000), // from past 24h just in case of delays
            },
          },
          {
            patientConfirmationStatus: "pending",
            appointmentDate: {
              gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
              lte: now,
            },
          },
        ],
      },
      include: {
        patient: {
          select: {
            id: true,
            name: true,
            cardNumber: true,
            age: true,
            email: true,
            gender: true,
            phone: true,
            address: true,
            clinic: {
              select: {
                id: true,
                name: true,
                plan: true,
                subscriptionEnds: true,
                paystackSubscriptionStatus: true,
                reminderOffsets: true,
              },
            },
          },
        },
      },
      orderBy: { appointmentDate: "asc" },
    });

    for (const appointment of appointments) {
      const patient = toDecryptedPatient(appointment.patient);
      const clinic = appointment.patient?.clinic;
      const appointmentStart = getAppointmentStartDateTime(
        appointment.appointmentDate,
        appointment.timeSlot,
      );

      if (!appointmentStart) {
        continue;
      }

      if (
        appointmentStart <= now &&
        appointment.patientConfirmationStatus === "pending"
      ) {
        await prisma.appointment.update({
          where: { id: appointment.id },
          data: {
            reminderEnabled: false,
            reminderStatus: "expired",
            patientConfirmationStatus: "no_response",
          },
        });
        continue;
      }

      if (appointmentStart <= now) {
        continue;
      }

      if (!hasReminderAccess(clinic)) {
        await markReminderDisabled(
          appointment.id,
          "plan_locked",
          getReminderAccessRequiredMessage(),
        );
        continue;
      }

      const hasEmailTarget =
        Boolean(patient?.email) && isEmailConfigured();
      const hasSmsTarget =
        Boolean(patient?.phone) &&
        isLikelyE164PhoneNumber(patient.phone) &&
        isSmsConfigured();

      if (!hasEmailTarget && !hasSmsTarget) {
        const hasEmail = Boolean(String(patient?.email || "").trim());
        const hasPhone = Boolean(String(patient?.phone || "").trim());
        const hasValidPhone =
          hasPhone && isLikelyE164PhoneNumber(patient.phone);

        const unavailableResult = getReminderDeliveryUnavailableError({
          hasEmail,
          hasPhone,
          hasValidPhone,
        });

        await markReminderDisabled(
          appointment.id,
          unavailableResult.status,
          unavailableResult.message,
        );
        continue;
      }

      const timeUntilAppointmentMs = appointmentStart.getTime() - now.getTime();
      
      const clinicOffsets = Array.isArray(clinic?.reminderOffsets) ? clinic.reminderOffsets : [1440, 120];
      const remindersSent = Array.isArray(appointment.remindersSent) ? appointment.remindersSent : [];
      
      // Find the first matching offset that hasn't been sent and is due
      let targetOffset = null;
      for (const offset of clinicOffsets) {
        if (
          !remindersSent.includes(offset) && 
          timeUntilAppointmentMs <= offset * 60 * 1000 + REMINDER_POLL_INTERVAL_MS && 
          timeUntilAppointmentMs > 0
        ) {
           targetOffset = offset;
           break; // Process one reminder at a time
        }
      }

      if (!targetOffset) {
        continue;
      }

      try {
        const deliveries = [];

        if (hasEmailTarget) {
          deliveries.push(
            {
              channel: "email",
              promise: sendReminderEmail({
                email: patient.email,
                patientName: patient.name,
                clinicName: clinic?.name,
                appointmentDate: appointmentStart,
                timeSlot: appointment.timeSlot,
                type: targetOffset,
                responseToken: appointment.patientResponseToken,
              }),
            },
          );
        }

        if (hasSmsTarget) {
          deliveries.push(
            {
              channel: "sms",
              promise: sendReminderSms({
                phone: patient.phone,
                patientName: patient.name,
                clinicName: clinic?.name,
                appointmentDate: appointmentStart,
                timeSlot: appointment.timeSlot,
                type: targetOffset,
                responseToken: appointment.patientResponseToken,
              }),
            },
          );
        }

        const results = await Promise.allSettled(
          deliveries.map((delivery) => delivery.promise),
        );
        const failedDeliveries = results
          .map((result, index) => ({ result, channel: deliveries[index].channel }))
          .filter(({ result }) => result.status === "rejected");

        if (failedDeliveries.length === deliveries.length) {
          throw failedDeliveries[0].result.reason;
        }

        const partialFailureMessage = failedDeliveries.length
          ? failedDeliveries
              .map(
                ({ channel, result }) =>
                  `${channel} failed: ${result.reason?.message || String(result.reason || "Unknown delivery error")}`,
              )
              .join(" | ")
          : "";

        await markReminderSent(
          appointment.id,
          targetOffset,
          partialFailureMessage,
        );
      } catch (error) {
        console.error(
          `Appointment reminder failed for ${appointment.id}:`,
          error.message,
        );
        await markReminderFailure(appointment.id, error.message);
      }
    }
  } finally {
    reminderJobRunning = false;
  }
};

export const startAppointmentReminderWorker = () => {
  if (reminderIntervalId || !hasReminderDeliveryConfigured()) {
    if (!hasReminderDeliveryConfigured()) {
      console.log(
        "Appointment reminder worker not started: reminder delivery is not configured.",
      );
    }
    return;
  }

  processAppointmentReminders().catch((error) => {
    console.error("Initial appointment reminder job failed:", error.message);
  });

  reminderIntervalId = setInterval(() => {
    processAppointmentReminders().catch((error) => {
      console.error("Appointment reminder job failed:", error.message);
    });
  }, REMINDER_POLL_INTERVAL_MS);

  console.log("Appointment reminder worker started.");
};
