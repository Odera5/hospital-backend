import crypto from "crypto";
import nodemailer from "nodemailer";

const VERIFICATION_WINDOW_MS = 1000 * 60 * 60 * 24;
const RESEND_API_URL = "https://api.resend.com/emails";

const getBaseUrl = () =>
  process.env.APP_BASE_URL?.trim() ||
  process.env.FRONTEND_URL?.trim() ||
  process.env.CORS_ORIGIN?.split(",")[0]?.trim() ||
  "http://localhost:5173";

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

let transporter;

const getSenderEmail = () =>
  process.env.EMAIL_FROM?.trim() || process.env.SMTP_FROM_EMAIL?.trim() || "";

const getTransporter = () => {
  if (!isMailConfigured()) {
    throw new Error(
      "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM_EMAIL.",
    );
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
      disableFileAccess: true,
      disableUrlAccess: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  return transporter;
};

export const createEmailVerification = () => {
  const token = crypto.randomBytes(32).toString("hex");

  return {
    token,
    expiresAt: new Date(Date.now() + VERIFICATION_WINDOW_MS),
  };
};

export const generateOtp = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export const sendVerificationEmail = async ({ email, name, token }) => {
  const verificationLink = `${getBaseUrl().replace(/\/$/, "")}/verify-email?token=${token}`;
  const recipientName = name?.trim() || "there";
  const subject = "Welcome to CareChrome Management Software";
  const text = [
    `Hello ${recipientName},`,
    "",
    "Welcome to CareChrome Management Software.",
    "Please click the link below to confirm your email address and activate your account:",
    verificationLink,
    "",
    "If you did not expect this email, you can ignore it.",
  ].join("\n");
  const html = `
      <div style="font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; padding: 40px 20px;">
        <div style="max-width: 560px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 48px 40px; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05); text-align: center;">
          <div style="margin-bottom: 24px; display: inline-block; background-color: #ccfbf1; padding: 14px; border-radius: 50%;">
            <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto;">
              <tr>
                <td>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0d9488" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display: block;">
                     <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                     <polyline points="22 4 12 14.01 9 11.01"></polyline>
                  </svg>
                </td>
              </tr>
            </table>
          </div>
          <p style="margin: 0 0 12px; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #0d9488;">CareChrome Verification</p>
          <h1 style="margin: 0 0 20px; font-size: 26px; font-weight: 800; color: #0f172a; line-height: 1.3;">Welcome to CareChrome</h1>
          <p style="margin: 0 0 32px; font-size: 16px; color: #475569; line-height: 1.6; text-align: left;">
            Hello ${recipientName},<br><br>
            Your account has been created successfully. To complete your registration and secure your account, please verify your email address. This verification link is valid for 24 hours.
          </p>
          <div style="margin: 32px 0;">
            <a href="${verificationLink}" style="display: inline-block; background-color: #0f766e; color: #ffffff; text-decoration: none; padding: 16px 36px; border-radius: 12px; font-weight: 600; font-size: 16px;">
              Verify Email Address
            </a>
          </div>
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 32px 0;">
          <p style="margin: 0 0 8px; font-size: 13px; color: #64748b; line-height: 1.6; text-align: left;">
            If the button doesn't work, copy and paste this link securely into your browser:
          </p>
          <p style="margin: 0; font-size: 13px; word-break: break-all; color: #0f766e; text-align: left; text-decoration: underline;">
            ${verificationLink}
          </p>
        </div>
        <div style="max-width: 560px; margin: 24px auto 0; text-align: center; color: #94a3b8; font-size: 13px;">
          <p style="margin: 0;">&copy; ${new Date().getFullYear()} CareChrome Management. All rights reserved.</p>
        </div>
      </div>
    `;

  if (isResendConfigured()) {
    const response = await fetch(RESEND_API_URL, {
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
      const error = new Error(`Resend API error: ${response.status} ${errorText}`);
      error.code = "RESEND_API_ERROR";
      throw error;
    }

    return;
  }

  await getTransporter().sendMail({
    from: `"CareChrome" <${getSenderEmail()}>`,
    to: email,
    subject,
    text,
    html,
  });
};

export const sendDeactivationOtpEmail = async ({ email, name, otp }) => {
  const recipientName = name?.trim() || "there";
  const subject = "Clinic Deactivation Verification Code - CareChrome";
  const text = [
    `Hello ${recipientName},`,
    "",
    "You have initiated the process to deactivate your clinic account.",
    `Your verification code is: ${otp}`,
    "",
    "This code will expire in 15 minutes. If you did not request this, please secure your account immediately.",
  ].join("\n");
  const html = `
      <div style="font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; padding: 40px 20px;">
        <div style="max-width: 560px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 48px 40px; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05); text-align: center;">
          <h1 style="margin: 0 0 20px; font-size: 26px; font-weight: 800; color: #b91c1c; line-height: 1.3;">Deactivation Request</h1>
          <p style="margin: 0 0 32px; font-size: 16px; color: #475569; line-height: 1.6; text-align: left;">
            Hello ${recipientName},<br><br>
            A request was made to deactivate your clinic account. If you proceed, all staff logins will be blocked and your subscription will be paused.
          </p>
          <div style="margin: 32px 0; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px;">
            <p style="margin: 0 0 8px; font-size: 14px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Your Verification Code</p>
            <p style="margin: 0; font-size: 32px; font-weight: 800; color: #0f172a; letter-spacing: 0.25em;">${otp}</p>
          </div>
          <p style="margin: 0 0 8px; font-size: 14px; color: #dc2626; line-height: 1.6; text-align: center; font-weight: 500;">
            This code will expire in 15 minutes.
          </p>
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 32px 0;">
          <p style="margin: 0 0 8px; font-size: 13px; color: #64748b; line-height: 1.6; text-align: left;">
            If you did not request this deactivation, please ignore this email and secure your account immediately.
          </p>
        </div>
        <div style="max-width: 560px; margin: 24px auto 0; text-align: center; color: #94a3b8; font-size: 13px;">
          <p style="margin: 0;">&copy; ${new Date().getFullYear()} CareChrome Management. All rights reserved.</p>
        </div>
      </div>
    `;

  if (isResendConfigured()) {
    const response = await fetch(RESEND_API_URL, {
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
      const error = new Error(`Resend API error: ${response.status} ${errorText}`);
      error.code = "RESEND_API_ERROR";
      throw error;
    }

    return;
  }

  await getTransporter().sendMail({
    from: `"CareChrome" <${getSenderEmail()}>`,
    to: email,
    subject,
    text,
    html,
  });
};

export const sendPasswordResetEmail = async ({ email, name, token }) => {
  const resetLink = `${getBaseUrl().replace(/\/$/, "")}/reset-password?token=${token}`;
  const recipientName = name?.trim() || "there";
  const subject = "Password Reset Request - CareChrome";
  const text = [
    `Hello ${recipientName},`,
    "",
    "We received a request to reset your password.",
    "Please click the link below to choose a new password:",
    resetLink,
    "",
    "This link will expire in 1 hour.",
    "If you did not request this, please ignore this email and your password will remain unchanged.",
  ].join("\n");
  const html = `
      <div style="font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; padding: 40px 20px;">
        <div style="max-width: 560px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 48px 40px; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05); text-align: center;">
          <h1 style="margin: 0 0 20px; font-size: 26px; font-weight: 800; color: #0f172a; line-height: 1.3;">Reset Your Password</h1>
          <p style="margin: 0 0 32px; font-size: 16px; color: #475569; line-height: 1.6; text-align: left;">
            Hello ${recipientName},<br><br>
            We received a request to reset the password for your CareChrome account. Click the button below to choose a new password. This link is valid for 1 hour.
          </p>
          <div style="margin: 32px 0;">
            <a href="${resetLink}" style="display: inline-block; background-color: #0f766e; color: #ffffff; text-decoration: none; padding: 16px 36px; border-radius: 12px; font-weight: 600; font-size: 16px;">
              Reset Password
            </a>
          </div>
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 32px 0;">
          <p style="margin: 0 0 8px; font-size: 13px; color: #64748b; line-height: 1.6; text-align: left;">
            If the button doesn't work, copy and paste this link securely into your browser:
          </p>
          <p style="margin: 0; font-size: 13px; word-break: break-all; color: #0f766e; text-align: left; text-decoration: underline;">
            ${resetLink}
          </p>
          <p style="margin: 24px 0 0; font-size: 13px; color: #64748b; line-height: 1.6; text-align: left;">
            If you did not request a password reset, please ignore this email. Your password will remain unchanged.
          </p>
        </div>
        <div style="max-width: 560px; margin: 24px auto 0; text-align: center; color: #94a3b8; font-size: 13px;">
          <p style="margin: 0;">&copy; ${new Date().getFullYear()} CareChrome Management. All rights reserved.</p>
        </div>
      </div>
    `;

  if (isResendConfigured()) {
    const response = await fetch(RESEND_API_URL, {
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
      const error = new Error(`Resend API error: ${response.status} ${errorText}`);
      error.code = "RESEND_API_ERROR";
      throw error;
    }

    return;
  }

  await getTransporter().sendMail({
    from: `"CareChrome" <${getSenderEmail()}>`,
    to: email,
    subject,
    text,
    html,
  });
};

export const sendBirthdayGreetingEmail = async ({ email, name, clinicName }) => {
  const recipientName = name?.trim() || "there";
  const subject = `Happy Birthday from ${clinicName || "CareChrome"}! 🎉`;
  const text = [
    `Hello ${recipientName},`,
    "",
    `Happy Birthday from all of us at ${clinicName || "your clinic"}!`,
    "We wish you a wonderful year ahead filled with joy, good health, and success.",
    "",
    "Best regards,",
    `${clinicName || "CareChrome Team"}`,
  ].join("\n");
  const html = `
      <div style="font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; padding: 40px 20px;">
        <div style="max-width: 560px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 48px 40px; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05); text-align: center;">
          <div style="margin-bottom: 24px; display: inline-block; background-color: #fef3c7; padding: 14px; border-radius: 50%;">
            <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto;">
              <tr>
                <td>
                  <span style="font-size: 32px; display: block; line-height: 1;">🎉</span>
                </td>
              </tr>
            </table>
          </div>
          <p style="margin: 0 0 12px; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #d97706;">Happy Birthday!</p>
          <h1 style="margin: 0 0 20px; font-size: 26px; font-weight: 800; color: #0f172a; line-height: 1.3;">Wishing You a Wonderful Day!</h1>
          <p style="margin: 0 0 32px; font-size: 16px; color: #475569; line-height: 1.6; text-align: left;">
            Hello ${recipientName},<br><br>
            Happy Birthday from all of us at <strong>${clinicName || "your clinic"}</strong>!<br><br>
            We hope your special day is filled with happiness, laughter, and wonderful memories. It is our pleasure to have you as a valued patient, and we look forward to caring for your smile in the year ahead.
          </p>
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 32px 0;">
          <p style="margin: 0; font-size: 13px; color: #64748b; text-align: center;">
            Warmest wishes,<br>
            <strong>${clinicName || "CareChrome"}</strong>
          </p>
        </div>
        <div style="max-width: 560px; margin: 24px auto 0; text-align: center; color: #94a3b8; font-size: 13px;">
          <p style="margin: 0;">&copy; ${new Date().getFullYear()} ${clinicName || "CareChrome"}. All rights reserved.</p>
        </div>
      </div>
    `;

  if (isResendConfigured()) {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${clinicName || "CareChrome"} <${getSenderEmail()}>`,
        to: [email],
        subject,
        text,
        html,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Resend API error: ${response.status} ${errorText}`);
      error.code = "RESEND_API_ERROR";
      throw error;
    }

    return;
  }

  await getTransporter().sendMail({
    from: `"${clinicName || "CareChrome"}" <${getSenderEmail()}>`,
    to: email,
    subject,
    text,
    html,
  });
};

export const sendAdminNewClinicAlert = async ({ clinic, adminUser, ipAddress }) => {
  const adminNotificationEmail =
    process.env.ADMIN_NOTIFICATION_EMAIL?.trim() || "primuxcare@gmail.com";

  const recipientEmails = adminNotificationEmail
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  if (recipientEmails.length === 0) return;

  const appBaseUrl = getBaseUrl().replace(/\/$/, "");
  const subject = `🚨 New Clinic Registered: ${clinic.name} (${clinic.city ? `${clinic.city}, ` : ""}${clinic.country || "Global"})`;
  const formattedDate = new Date().toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "medium",
  });

  const text = [
    "New Clinic Registration Alert - CareChrome",
    "",
    "A new clinic environment has just been registered:",
    `• Clinic Name: ${clinic.name}`,
    `• Clinic Email: ${clinic.email}`,
    `• Clinic Phone: ${clinic.phone || "Not provided"}`,
    `• Location: ${clinic.city ? `${clinic.city}, ` : ""}${clinic.country || "Not provided"}`,
    `• Address: ${clinic.address || "Not provided"}`,
    "",
    "Primary Admin Details:",
    `• Admin Name: ${adminUser.name}`,
    `• Admin Email: ${adminUser.email}`,
    `• Registered IP: ${ipAddress || "Unknown"}`,
    `• Registration Time: ${formattedDate}`,
    "",
    `Sign in to review or manage clinic status: ${appBaseUrl}/login`,
  ].join("\n");

  const html = `
      <div style="font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; padding: 40px 20px;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; padding: 40px 36px; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
          
          <div style="display: flex; align-items: center; margin-bottom: 24px;">
            <div style="display: inline-block; background-color: #ecfdf5; border: 1px solid #a7f3d0; padding: 10px 14px; border-radius: 10px;">
              <span style="font-size: 20px; vertical-align: middle;">🏥</span>
              <span style="color: #065f46; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-left: 6px;">New Clinic Alert</span>
            </div>
          </div>

          <h1 style="margin: 0 0 12px; font-size: 22px; font-weight: 800; color: #0f172a; line-height: 1.3;">
            ${clinic.name} Just Registered
          </h1>
          <p style="margin: 0 0 24px; font-size: 15px; color: #475569; line-height: 1.6;">
            A new clinic account was just initialized on <strong>CareChrome</strong>. Here are the registration details:
          </p>

          <!-- Clinic Details Box -->
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
            <h2 style="margin: 0 0 14px; font-size: 13px; font-weight: 700; text-transform: uppercase; color: #0f766e; letter-spacing: 0.05em;">
              Clinic Details
            </h2>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #334155;">
              <tr>
                <td style="padding: 6px 0; color: #64748b; width: 35%;">Clinic Name:</td>
                <td style="padding: 6px 0; font-weight: 600; color: #0f172a;">${clinic.name}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Clinic Email:</td>
                <td style="padding: 6px 0; font-weight: 600; color: #0f172a;"><a href="mailto:${clinic.email}" style="color: #0f766e; text-decoration: none;">${clinic.email}</a></td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Clinic Phone:</td>
                <td style="padding: 6px 0;">${clinic.phone || "Not provided"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Location:</td>
                <td style="padding: 6px 0;">${clinic.city ? `${clinic.city}, ` : ""}${clinic.country || "Not provided"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Street Address:</td>
                <td style="padding: 6px 0;">${clinic.address || "Not provided"}</td>
              </tr>
            </table>
          </div>

          <!-- Admin Contact Box -->
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
            <h2 style="margin: 0 0 14px; font-size: 13px; font-weight: 700; text-transform: uppercase; color: #0f766e; letter-spacing: 0.05em;">
              Primary Admin Contact
            </h2>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #334155;">
              <tr>
                <td style="padding: 6px 0; color: #64748b; width: 35%;">Admin Name:</td>
                <td style="padding: 6px 0; font-weight: 600; color: #0f172a;">${adminUser.name}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Admin Email:</td>
                <td style="padding: 6px 0; font-weight: 600; color: #0f172a;"><a href="mailto:${adminUser.email}" style="color: #0f766e; text-decoration: none;">${adminUser.email}</a></td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Registration IP:</td>
                <td style="padding: 6px 0; font-family: monospace; color: #475569;">${ipAddress || "Unknown"}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b;">Timestamp:</td>
                <td style="padding: 6px 0; color: #475569;">${formattedDate}</td>
              </tr>
            </table>
          </div>

          <!-- Actions -->
          <div style="text-align: center; margin: 32px 0 24px;">
            <a href="${appBaseUrl}/login" style="display: inline-block; background-color: #0f766e; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-weight: 600; font-size: 15px; margin-right: 12px;">
              Open CareChrome Portal
            </a>
          </div>

          <p style="margin: 0; font-size: 12px; color: #94a3b8; text-align: center; line-height: 1.5;">
            Tip: If this is an unauthorized or suspicious test account, you can quickly deactivate this clinic using the admin panel or CLI tool: <code>node deactivate_clinic.js ${clinic.email}</code>
          </p>

          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 28px 0 20px;">
          <div style="text-align: center; color: #94a3b8; font-size: 12px;">
            <p style="margin: 0;">Primux Care • CareChrome Security System</p>
          </div>
        </div>
      </div>
    `;

  if (isResendConfigured()) {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `CareChrome Security <${getSenderEmail()}>`,
        to: recipientEmails,
        subject,
        text,
        html,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Resend API error: ${response.status} ${errorText}`);
      error.code = "RESEND_API_ERROR";
      throw error;
    }

    return;
  }

  await getTransporter().sendMail({
    from: `"CareChrome Security" <${getSenderEmail()}>`,
    to: recipientEmails.join(", "),
    subject,
    text,
    html,
  });
};

export const getVerificationErrorMessage = (error) => {
  if (
    error?.message?.includes("SMTP is not configured") ||
    error?.code === "EAUTH" ||
    error?.code === "ECONNECTION" ||
    error?.code === "ETIMEDOUT"
  ) {
    return "Verification email could not be sent. Check the SMTP configuration.";
  }

  if (error?.code === "RESEND_API_ERROR") {
    return "Verification email could not be sent. Check the Resend configuration.";
  }

  return "Verification email could not be sent.";
};
