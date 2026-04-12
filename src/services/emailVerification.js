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

export const sendVerificationEmail = async ({ email, name, token }) => {
  const verificationLink = `${getBaseUrl().replace(/\/$/, "")}/verify-email?token=${token}`;
  const recipientName = name?.trim() || "there";
  const subject = "Welcome to PrimuxCare BHF Management Software";
  const text = [
    `Hello ${recipientName},`,
    "",
    "Welcome to PrimuxCare BHF Management Software.",
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
          <p style="margin: 0 0 12px; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #0d9488;">PrimuxCare Verification</p>
          <h1 style="margin: 0 0 20px; font-size: 26px; font-weight: 800; color: #0f172a; line-height: 1.3;">Welcome to PrimuxCare BHF</h1>
          <p style="margin: 0 0 32px; font-size: 16px; color: #475569; line-height: 1.6; text-align: left;">
            Hello ${recipientName},<br><br>
            Your account has been created successfully. To complete your registration and secure your account, please verify your email address.
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
          <p style="margin: 0;">&copy; ${new Date().getFullYear()} PrimuxCare BHF Management. All rights reserved.</p>
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
        from: `PrimuxCare <${getSenderEmail()}>`,
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
    from: `"PrimuxCare" <${getSenderEmail()}>`,
    to: email,
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
