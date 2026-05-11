import nodemailer from "nodemailer";
import { env } from "../config/env";

type ReceptionistInviteEmailInput = {
  to: string;
  clinicName: string;
  role: string;
  webLink: string;
};

type DoctorInviteEmailInput = {
  to: string;
  clinicName: string;
  webLink: string;
};

type PasswordResetEmailInput = {
  to: string;
  name?: string;
  resetLink?: string;
  webLink?: string;
};

let cachedTransporter: any = null;
let transporterVerified = false;

const assertNotPlaceholderValue = (key: string, value: string) => {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "your_email@gmail.com" ||
    normalized === "your_app_password" ||
    normalized === "change_me"
  ) {
    throw new Error(`${key} is using a placeholder value`);
  }
};

const getTransporter = () => {
  if (cachedTransporter) {
    return cachedTransporter;
  }

  const host = env.smtpHost;
  const port = env.smtpPort;
  const user = env.smtpUser;
  const pass = env.smtpPass;

  if (!host || !user || !pass) {
    throw new Error("SMTP_HOST, SMTP_USER and SMTP_PASS must be configured");
  }

  const secure = env.smtpSecure || port === 465;

  assertNotPlaceholderValue("SMTP_USER", user);
  assertNotPlaceholderValue("SMTP_PASS", pass);

  const service = env.smtpService || (host.toLowerCase() === "smtp.gmail.com" ? "gmail" : "");

  cachedTransporter = nodemailer.createTransport({
    ...(service ? { service } : { host, port, secure }),
    auth: {
      user,
      pass,
    },
  });

  return cachedTransporter;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const sendReceptionistInviteEmail = async ({
  to,
  clinicName,
  role,
  webLink,
}: ReceptionistInviteEmailInput) => {
  const transporter = getTransporter();
  const from = env.smtpFrom || env.smtpUser;

  if (!from) {
    throw new Error("SMTP_FROM or SMTP_USER must be configured");
  }

  assertNotPlaceholderValue("SMTP_FROM", from);

  if (!transporterVerified) {
    await transporter.verify();
    transporterVerified = true;
  }

  const safeClinicName = escapeHtml(clinicName);
  const safeRole = escapeHtml(role);
  const safeWebLink = escapeHtml(webLink);

  await transporter.sendMail({
    from,
    to,
    subject: "You're invited to HealthLink",
    text: [
      `You've been invited to join ${clinicName} on HealthLink as a ${role}.`,
      "",
      "Set Your Password:",
      webLink,
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; background:#F4F7FB; padding:32px;">
        <div style="max-width:560px; margin:0 auto; background:#FFFFFF; border-radius:20px; padding:32px; border:1px solid #E5E7EB;">
          <p style="margin:0 0 12px; color:#6B7280; font-size:14px;">HealthLink Invitation</p>
          <h1 style="margin:0 0 16px; color:#1F2937; font-size:28px;">You're invited to HealthLink</h1>
          <p style="margin:0 0 8px; color:#374151; font-size:16px;">
            Clinic: <strong>${safeClinicName}</strong>
          </p>
          <p style="margin:0 0 24px; color:#374151; font-size:16px;">
            Role: <strong>${safeRole}</strong>
          </p>
          <a
            href="${safeWebLink}"
            style="display:inline-block; background:#10B981; color:#FFFFFF; text-decoration:none; font-weight:700; padding:14px 22px; border-radius:14px;"
          >
            Set Your Password
          </a>
          <p style="margin:24px 0 0; color:#6B7280; font-size:13px; line-height:20px;">
            If the button does not open, copy and paste this link into your browser:
          </p>
          <p style="margin:8px 0 0; color:#2563EB; font-size:13px; word-break:break-all;">
            ${safeWebLink}
          </p>
        </div>
      </div>
    `,
  });
};

export const sendDoctorInviteEmail = async ({
  to,
  clinicName,
  webLink,
}: DoctorInviteEmailInput) => {
  const transporter = getTransporter();
  const from = env.smtpFrom || env.smtpUser;

  if (!from) {
    throw new Error("SMTP_FROM or SMTP_USER must be configured");
  }

  assertNotPlaceholderValue("SMTP_FROM", from);

  if (!transporterVerified) {
    await transporter.verify();
    transporterVerified = true;
  }

  const safeClinicName = escapeHtml(clinicName);
  const safeWebLink = escapeHtml(webLink);

  await transporter.sendMail({
    from,
    to,
    subject: "You've been invited to join a medical center on HealthLink",
    text: [
      `You've been invited to join ${clinicName} on HealthLink as a doctor.`,
      "",
      "Complete doctor registration or accept the invite:",
      webLink,
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; background:#F4F7FB; padding:32px;">
        <div style="max-width:560px; margin:0 auto; background:#FFFFFF; border-radius:20px; padding:32px; border:1px solid #E5E7EB;">
          <p style="margin:0 0 12px; color:#6B7280; font-size:14px;">HealthLink Doctor Invitation</p>
          <h1 style="margin:0 0 16px; color:#1F2937; font-size:28px;">Join ${safeClinicName}</h1>
          <p style="margin:0 0 24px; color:#374151; font-size:16px;">
            You have been invited to connect your doctor account with <strong>${safeClinicName}</strong>.
          </p>
          <a
            href="${safeWebLink}"
            style="display:inline-block; background:#2563EB; color:#FFFFFF; text-decoration:none; font-weight:700; padding:14px 22px; border-radius:14px;"
          >
            Continue
          </a>
          <p style="margin:24px 0 0; color:#6B7280; font-size:13px; line-height:20px;">
            If the button does not open, copy and paste this link into your browser:
          </p>
          <p style="margin:8px 0 0; color:#2563EB; font-size:13px; word-break:break-all;">
            ${safeWebLink}
          </p>
        </div>
      </div>
    `,
  });
};

export const sendPasswordResetEmail = async ({
  to,
  name,
  resetLink,
  webLink,
}: PasswordResetEmailInput) => {
  const transporter = getTransporter();
  const from = env.smtpFrom || env.smtpUser;

  if (!from) {
    throw new Error("SMTP_FROM or SMTP_USER must be configured");
  }

  assertNotPlaceholderValue("SMTP_FROM", from);

  if (!transporterVerified) {
    await transporter.verify();
    transporterVerified = true;
  }

  const safeName = escapeHtml(String(name || "there"));
  const resolvedResetLink = String(resetLink || webLink || "").trim();
  const safeResetLink = escapeHtml(resolvedResetLink);

  await transporter.sendMail({
    from,
    to,
    subject: "Reset your HealthLink password",
    text: [
      `Hi ${name || "there"},`,
      "",
      "Reset your password using this link:",
      resolvedResetLink,
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; background:#F4F7FB; padding:32px;">
        <div style="max-width:560px; margin:0 auto; background:#FFFFFF; border-radius:20px; padding:32px; border:1px solid #E5E7EB;">
          <h1 style="margin:0 0 16px; color:#1F2937; font-size:28px;">Reset your password</h1>
          <p style="margin:0 0 24px; color:#374151; font-size:16px;">Hi ${safeName},</p>
          <a
            href="${safeResetLink}"
            style="display:inline-block; background:#2563EB; color:#FFFFFF; text-decoration:none; font-weight:700; padding:14px 22px; border-radius:14px;"
          >
            Reset Password
          </a>
          <p style="margin:24px 0 0; color:#6B7280; font-size:13px; line-height:20px;">
            If the button does not open, copy and paste this link into your browser:
          </p>
          <p style="margin:8px 0 0; color:#2563EB; font-size:13px; word-break:break-all;">
            ${safeResetLink}
          </p>
        </div>
      </div>
    `,
  });
};
