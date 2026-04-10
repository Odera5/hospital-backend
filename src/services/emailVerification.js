import crypto from "crypto";
import nodemailer from "nodemailer";

const VERIFICATION_WINDOW_MS = 1000 * 60 * 60 * 24;

const getBaseUrl = () =>
  process.env.APP_BASE_URL?.trim() ||
  process.env.FRONTEND_URL?.trim() ||
  process.env.CORS_ORIGIN?.split(",")[0]?.trim() ||
  "http://localhost:5173";

const isMailConfigured = () =>
  Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_PORT?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim() &&
      process.env.SMTP_FROM_EMAIL?.trim(),
  );

let transporter;

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

  await getTransporter().sendMail({
    from: `"PrimuxCare" <${process.env.SMTP_FROM_EMAIL}>`,
    to: email,
    subject: "Welcome to PrimuxCare BHF Management Software",
    text: [
      `Hello ${recipientName},`,
      "",
      "Welcome to PrimuxCare BHF Management Software.",
      "Please click the link below to confirm your email address and activate your account:",
      verificationLink,
      "",
      "If you did not expect this email, you can ignore it.",
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; background: #f8fafc; padding: 32px;">
        <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 18px; padding: 32px; border: 1px solid #e2e8f0;">
          <p style="margin: 0 0 8px; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: #0f766e;">PrimuxCare BHF</p>
          <h1 style="margin: 0 0 16px; font-size: 28px; color: #0f172a;">Welcome to PrimuxCare BHF Management Software</h1>
          <p style="margin: 0 0 12px; color: #334155; line-height: 1.6;">Hello ${recipientName},</p>
          <p style="margin: 0 0 12px; color: #334155; line-height: 1.6;">
            Your account has been created successfully. Click the button below to confirm your email address and activate your account.
          </p>
          <div style="margin: 28px 0;">
            <a href="${verificationLink}" style="display: inline-block; background: #0f766e; color: #ffffff; text-decoration: none; padding: 14px 22px; border-radius: 12px; font-weight: 600;">
              Confirm Email Address
            </a>
          </div>
          <p style="margin: 0 0 8px; color: #64748b; line-height: 1.6;">
            If the button does not work, copy and paste this link into your browser:
          </p>
          <p style="margin: 0; word-break: break-all; color: #0f766e;">${verificationLink}</p>
        </div>
      </div>
    `,
  });
};

export const getVerificationErrorMessage = (error) => {
  if (
    error?.message?.includes("SMTP is not configured") ||
    error?.code === "EAUTH" ||
    error?.code === "ECONNECTION"
  ) {
    return "Verification email could not be sent. Check the SMTP configuration.";
  }

  return "Verification email could not be sent.";
};
