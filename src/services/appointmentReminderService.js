import { prisma } from "../lib/prisma.js";
import { toDecryptedPatient } from "../utils/patientCrypto.js";
import {
  hasReminderAccess,
  getReminderAccessRequiredMessage,
} from "../utils/subscriptionAccess.js";

const RESEND_API_URL = "https://api.resend.com/emails";
const TWILIO_API_BASE_URL = "https://api.twilio.com/2010-04-01";
const REMINDER_POLL_INTERVAL_MS = 5 * 60 * 1000;
const NOTIFICATION_POLL_INTERVAL_MS = 15 * 1000;
const NOTIFICATION_MAX_ATTEMPTS = 8;
const NOTIFICATION_BATCH_SIZE = 10;
const NOTIFICATION_LEASE_MS = 2 * 60 * 1000;
const DELIVERY_TIMEOUT_MS = 15 * 1000;

let transporterPromise = null;
let reminderIntervalId = null;
let notificationIntervalId = null;
let reminderJobRunning = false;
let notificationJobRunning = false;
let reminderWorkerDisabled = false;

const isMissingDatabaseColumnError = (error) =>
  error?.code === "P2022" ||
  Boolean(
    error?.message &&
      String(error.message).includes(
        "does not exist in the current database.",
      ),
  );

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
        requireTLS:
          String(process.env.SMTP_SECURE || "").toLowerCase() !== "true",
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
        disableFileAccess: true,
        disableUrlAccess: true,
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

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return entities[character];
  });

const fetchWithTimeout = (url, options) =>
  fetch(url, {
    ...options,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });

const buildReminderLinks = (responseToken) => {
  const baseUrl = getBaseUrl().replace(/\/+$/, "");
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
  const safePatientName = escapeHtml(patientName || "there");
  const safeClinicName = escapeHtml(clinicName || "Your clinic");
  const safeTitle = escapeHtml(title);
  const safeIntro = escapeHtml(intro);
  const safeDate = escapeHtml(formattedDate);
  const safeTime = escapeHtml(timeSlot);

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
          <h1 style="margin: 0 0 16px; color: #0f172a; font-size: 26px; line-height: 1.2;">${safeTitle}</h1>
          <p style="margin: 0 0 24px; color: #475569; font-size: 16px; line-height: 1.6;">
            Hello ${safePatientName},<br /><br />
            ${safeIntro}
          </p>
          <div style="background: linear-gradient(135deg, #ecfeff, #f8fafc); border: 1px solid #bae6fd; border-radius: 16px; padding: 20px 22px; margin-bottom: 24px;">
            <p style="margin: 0 0 8px; color: #0f172a; font-size: 15px;"><strong>Clinic:</strong> ${safeClinicName}</p>
            <p style="margin: 0 0 8px; color: #0f172a; font-size: 15px;"><strong>Date:</strong> ${safeDate}</p>
            <p style="margin: 0; color: #0f172a; font-size: 15px;"><strong>Time:</strong> ${safeTime}</p>
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

const buildBookingConfirmationEmailCopy = ({
  patientName,
  clinicName,
  appointmentDate,
  timeSlot,
  responseToken,
}) => {
  const dateObj = appointmentDate instanceof Date ? appointmentDate : new Date(appointmentDate);
  const formattedDate = dateObj.toLocaleDateString("en-NG", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  
  const title = "Appointment Booked Successfully";
  const intro = "Your appointment has been successfully scheduled. Here are the details of your booking:";
  const { confirmUrl, rescheduleUrl } = buildReminderLinks(responseToken);
  const safePatientName = escapeHtml(patientName || "there");
  const safeClinicName = escapeHtml(clinicName || "Your clinic");
  const safeDate = escapeHtml(formattedDate);
  const safeTime = escapeHtml(timeSlot);
  const safeTitle = escapeHtml(title);
  const safeIntro = escapeHtml(intro);

  return {
    subject: `Appointment Booked - ${clinicName || "Your Clinic"}`,
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
          <p style="margin: 0 0 10px; color: #0f766e; font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase;">Booking Confirmation</p>
          <h1 style="margin: 0 0 16px; color: #0f172a; font-size: 26px; line-height: 1.2;">${safeTitle}</h1>
          <p style="margin: 0 0 24px; color: #475569; font-size: 16px; line-height: 1.6;">
            Hello ${safePatientName},<br /><br />
            ${safeIntro}
          </p>
          <div style="background: linear-gradient(135deg, #ecfeff, #f8fafc); border: 1px solid #bae6fd; border-radius: 16px; padding: 20px 22px; margin-bottom: 24px;">
            <p style="margin: 0 0 8px; color: #0f172a; font-size: 15px;"><strong>Clinic:</strong> ${safeClinicName}</p>
            <p style="margin: 0 0 8px; color: #0f172a; font-size: 15px;"><strong>Date:</strong> ${safeDate}</p>
            <p style="margin: 0; color: #0f172a; font-size: 15px;"><strong>Time:</strong> ${safeTime}</p>
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

const sendReminderEmail = async ({
  email,
  patientName,
  clinicName,
  appointmentDate,
  timeSlot,
  type,
  responseToken,
  idempotencyKey,
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
    const response = await fetchWithTimeout(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `CareChrome <${getSenderEmail()}>`,
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
    from: `"CareChrome" <${getSenderEmail()}>`,
    to: email,
    subject,
    text,
    html,
  });
};

export const sendBookingConfirmationEmail = async ({
  email,
  patientName,
  clinicName,
  appointmentDate,
  timeSlot,
  responseToken,
}) => {
  const { subject, text, html } = buildBookingConfirmationEmailCopy({
    patientName,
    clinicName,
    appointmentDate,
    timeSlot,
    responseToken,
  });

  if (isResendConfigured()) {
    const response = await fetchWithTimeout(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `CareChrome <${getSenderEmail()}>`,
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
    from: `"CareChrome" <${getSenderEmail()}>`,
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
  const response = await fetchWithTimeout(
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

const queueReminderDeliveries = async ({
  appointment,
  appointmentStart,
  offset,
  channels,
}) => {
  const scheduledFor = appointmentStart.toISOString();

  await prisma.appointmentNotification.createMany({
    data: channels.map((channel) => ({
      appointmentId: appointment.id,
      dedupeKey: `reminder:${appointment.id}:${scheduledFor}:${offset}:${channel}`,
      channel,
      kind: "reminder",
      reminderOffset: offset,
      appointmentStart,
    })),
    skipDuplicates: true,
  });
};

const claimDueNotifications = () =>
  prisma.$queryRaw`
    WITH due AS (
      SELECT "id"
      FROM "AppointmentNotification"
      WHERE (
        ("status" = 'pending' AND "nextAttemptAt" <= NOW())
        OR ("status" = 'processing' AND "lockedUntil" <= NOW())
      )
      ORDER BY "nextAttemptAt", "createdAt"
      FOR UPDATE SKIP LOCKED
      LIMIT ${NOTIFICATION_BATCH_SIZE}
    )
    UPDATE "AppointmentNotification" AS notification
    SET
      "status" = 'processing',
      "attempts" = notification."attempts" + 1,
      "lockedUntil" = NOW() + (${NOTIFICATION_LEASE_MS} * INTERVAL '1 millisecond'),
      "updatedAt" = NOW()
    FROM due
    WHERE notification."id" = due."id"
    RETURNING
      notification."id",
      notification."appointmentId",
      notification."channel",
      notification."kind",
      notification."reminderOffset",
      notification."appointmentStart",
      notification."attempts"
  `;

const updateReminderOffsetStatus = async (
  tx,
  appointmentId,
  reminderOffset,
  appointmentStart,
  notifications,
) => {
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      appointmentDate: true,
      timeSlot: true,
      reminderEnabled: true,
      status: true,
    },
  });
  const currentStart = appointment
    ? getAppointmentStartDateTime(
        appointment.appointmentDate,
        appointment.timeSlot,
      )
    : null;
  if (
    !currentStart ||
    currentStart.getTime() !== new Date(appointmentStart).getTime() ||
    !appointment.reminderEnabled ||
    appointment.status !== "scheduled"
  ) {
    return;
  }

  if (
    notifications.some(
      ({ status }) => status === "pending" || status === "processing",
    )
  ) {
    await tx.appointment.updateMany({
      where: { id: appointmentId },
      data: { reminderStatus: "queued" },
    });
    return;
  }

  const sent = notifications.some(({ status }) => status === "sent");
  const errors = notifications
    .filter(({ status, lastError }) => status === "failed" && lastError)
    .map(({ lastError }) => lastError);

  await tx.$executeRaw`
    UPDATE "Appointment"
    SET
      "remindersSent" = CASE
        WHEN "remindersSent" @> jsonb_build_array(${reminderOffset})
          THEN "remindersSent"
        ELSE "remindersSent" || jsonb_build_array(${reminderOffset})
      END,
      "reminderStatus" = ${
        sent ? (errors.length ? "partial" : "sent") : "failed"
      },
      "reminderLastSentAt" = CASE
        WHEN ${sent} THEN NOW()
        ELSE "reminderLastSentAt"
      END,
      "reminderLastError" = ${errors.join(" | ").slice(0, 500)}
    WHERE "id" = ${appointmentId}
  `;
};

const finishNotification = async (notification, status, lastError = "") => {
  await prisma.$transaction(async (tx) => {
    await tx.appointmentNotification.update({
      where: { id: notification.id },
      data: {
        status,
        sentAt: status === "sent" ? new Date() : null,
        lockedUntil: null,
        lastError: String(lastError || "").slice(0, 500),
      },
    });

    if (notification.kind === "reminder") {
      const notifications = await tx.appointmentNotification.findMany({
        where: {
          appointmentId: notification.appointmentId,
          kind: "reminder",
          reminderOffset: notification.reminderOffset,
          appointmentStart: notification.appointmentStart,
        },
        select: { status: true, lastError: true },
      });
      await updateReminderOffsetStatus(
        tx,
        notification.appointmentId,
        notification.reminderOffset,
        notification.appointmentStart,
        notifications,
      );
    }
  });
};

const retryNotification = async (notification, error) => {
  const message = String(error?.message || error || "Notification delivery failed");
  const exhausted = notification.attempts >= NOTIFICATION_MAX_ATTEMPTS;

  if (exhausted) {
    await finishNotification(notification, "failed", message);
    console.error(
      `Appointment reminder permanently failed (${notification.id}) after ${notification.attempts} attempts:`,
      message,
    );
    return;
  }

  const delayMs = Math.min(
    60 * 60 * 1000,
    30 * 1000 * 2 ** Math.max(notification.attempts - 1, 0),
  );
  await prisma.appointmentNotification.update({
    where: { id: notification.id },
    data: {
      status: "pending",
      nextAttemptAt: new Date(Date.now() + delayMs),
      lockedUntil: null,
      lastError: message.slice(0, 500),
    },
  });
  console.error(
    `Appointment reminder delivery attempt ${notification.attempts} failed (${notification.id}); retrying:`,
    message,
  );
};

const deliverNotification = async (notification) => {
  const appointment = await prisma.appointment.findUnique({
    where: { id: notification.appointmentId },
    include: {
      patient: {
        select: {
          name: true,
          email: true,
          phone: true,
          clinic: {
            select: {
              name: true,
              plan: true,
              subscriptionEnds: true,
              paystackSubscriptionStatus: true,
              paystackNextPaymentDate: true,
              stripeSubscriptionStatus: true,
              stripeNextPaymentDate: true,
            },
          },
        },
      },
    },
  });

  if (!appointment || appointment.status !== "scheduled" || !appointment.reminderEnabled) {
    await finishNotification(notification, "cancelled", "Appointment reminder is no longer active.");
    return;
  }

  const appointmentStart = getAppointmentStartDateTime(
    appointment.appointmentDate,
    appointment.timeSlot,
  );
  if (
    !appointmentStart ||
    appointmentStart.getTime() !== new Date(notification.appointmentStart).getTime()
  ) {
    await finishNotification(notification, "cancelled", "Appointment reminder is no longer due.");
    return;
  }

  if (!hasReminderAccess(appointment.patient?.clinic)) {
    await markReminderDisabled(
      appointment.id,
      "plan_locked",
      getReminderAccessRequiredMessage(),
    );
    await finishNotification(notification, "cancelled", getReminderAccessRequiredMessage());
    return;
  }

  if (appointmentStart <= new Date()) {
    await markReminderDisabled(appointment.id, "expired");
    await finishNotification(notification, "cancelled", "Appointment time has passed.");
    return;
  }

  const patient = toDecryptedPatient(appointment.patient);
  if (notification.channel === "email") {
    if (!patient?.email || !isEmailConfigured()) {
      throw new Error("No configured email address is available for this appointment.");
    }

    await sendReminderEmail({
      email: patient.email,
      patientName: patient.name,
      clinicName: appointment.patient.clinic?.name,
      appointmentDate: appointmentStart,
      timeSlot: appointment.timeSlot,
      type: notification.reminderOffset,
      responseToken: appointment.patientResponseToken,
      idempotencyKey: notification.dedupeKey,
    });
  } else if (notification.channel === "sms") {
    if (
      !patient?.phone ||
      !isLikelyE164PhoneNumber(patient.phone) ||
      !isSmsConfigured()
    ) {
      throw new Error("No configured phone number is available for this appointment.");
    }

    await sendReminderSms({
      phone: patient.phone,
      patientName: patient.name,
      clinicName: appointment.patient.clinic?.name,
      appointmentDate: appointmentStart,
      timeSlot: appointment.timeSlot,
      type: notification.reminderOffset,
      responseToken: appointment.patientResponseToken,
    });
  } else {
    throw new Error(`Unsupported appointment notification channel: ${notification.channel}`);
  }

  await finishNotification(notification, "sent");
};

export const processAppointmentNotifications = async () => {
  if (notificationJobRunning || reminderWorkerDisabled) {
    return;
  }

  notificationJobRunning = true;
  try {
    const notifications = await claimDueNotifications();
    await Promise.all(
      notifications.map(async (notification) => {
        try {
          await deliverNotification(notification);
        } catch (error) {
          await retryNotification(notification, error);
        }
      }),
    );
  } finally {
    notificationJobRunning = false;
  }
};

export const processAppointmentReminders = async () => {
  if (
    reminderWorkerDisabled ||
    reminderJobRunning ||
    !hasReminderDeliveryConfigured()
  ) {
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
                paystackNextPaymentDate: true,
                stripeSubscriptionStatus: true,
                stripeNextPaymentDate: true,
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
      
      const clinicOffsets = (Array.isArray(clinic?.reminderOffsets) ? clinic.reminderOffsets : [1440, 120])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => b - a);
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

      const channels = [];
      if (hasEmailTarget) channels.push("email");
      if (hasSmsTarget) channels.push("sms");

      await queueReminderDeliveries({
        appointment,
        appointmentStart,
        offset: targetOffset,
        channels,
      });
    }
  } catch (error) {
    if (isMissingDatabaseColumnError(error)) {
      reminderWorkerDisabled = true;
      console.error(
        `Appointment reminder worker disabled: database schema is missing one or more required columns (${error?.meta?.column || error?.message || "unknown column"}). Run Prisma migrations on the deployed database.`,
      );
      return;
    }

    throw error;
  } finally {
    reminderJobRunning = false;
  }
};

export const startAppointmentReminderWorker = () => {
  if (
    reminderWorkerDisabled ||
    reminderIntervalId ||
    notificationIntervalId ||
    !hasReminderDeliveryConfigured()
  ) {
    if (!hasReminderDeliveryConfigured()) {
      console.log(
        "Appointment reminder worker not started: reminder delivery is not configured.",
      );
    }

    if (reminderWorkerDisabled) {
      console.log(
        "Appointment reminder worker not started: database schema is missing required reminder columns.",
      );
    }

    return;
  }

  processAppointmentReminders().catch((error) => {
    console.error("Initial appointment reminder job failed:", error.message);
  });
  processAppointmentNotifications().catch((error) => {
    console.error("Initial appointment notification job failed:", error.message);
  });

  reminderIntervalId = setInterval(() => {
    processAppointmentReminders().catch((error) => {
      console.error("Appointment reminder job failed:", error.message);
    });
  }, REMINDER_POLL_INTERVAL_MS);

  notificationIntervalId = setInterval(() => {
    processAppointmentNotifications().catch((error) => {
      console.error("Appointment notification job failed:", error.message);
    });
  }, NOTIFICATION_POLL_INTERVAL_MS);

  console.log("Appointment reminder worker started.");
};

export const stopAppointmentReminderWorker = async () => {
  if (reminderIntervalId) {
    clearInterval(reminderIntervalId);
    reminderIntervalId = null;
  }

  if (notificationIntervalId) {
    clearInterval(notificationIntervalId);
    notificationIntervalId = null;
  }

  const drainDeadline = Date.now() + 35_000;
  while (
    (reminderJobRunning || notificationJobRunning) &&
    Date.now() < drainDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (reminderJobRunning || notificationJobRunning) {
    console.warn(
      "Appointment notification worker shutdown timed out; in-flight notifications will be retried after their lease expires.",
    );
  }
};
