import dotenv from "dotenv";

dotenv.config();

const requireString = (key: string) => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const optionalString = (key: string) => {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
};

const optionalNumber = (key: string, fallback?: number) => {
  const value = process.env[key]?.trim();
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric environment variable: ${key}`);
  }
  return parsed;
};

const optionalBoolean = (key: string, fallback = false) => {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Invalid boolean environment variable: ${key}`);
};

const databaseUrl = requireString("DATABASE_URL");
const jwtSecret = requireString("JWT_SECRET");

export const env = {
  port: optionalNumber("PORT", 5050) ?? 5050,
  appTz: optionalString("APP_TZ") || "Asia/Colombo",
  databaseUrl,
  jwtSecret,
  pgSsl: optionalBoolean("PG_SSL", databaseUrl.includes("sslmode=require")),
  pgConnectTimeoutMs: optionalNumber("PG_CONNECT_TIMEOUT_MS", 30000) ?? 30000,
  pgIdleTimeoutMs: optionalNumber("PG_IDLE_TIMEOUT_MS", 30000) ?? 30000,
  pgPoolMax: optionalNumber("PG_POOL_MAX", 10) ?? 10,
  pgQueryRetry: optionalNumber("PG_QUERY_RETRY", 2) ?? 2,
  geminiApiKey: optionalString("GEMINI_API_KEY"),
  smtpHost: optionalString("SMTP_HOST"),
  smtpPort: optionalNumber("SMTP_PORT", 587) ?? 587,
  smtpSecure: optionalBoolean("SMTP_SECURE", false),
  smtpService: optionalString("SMTP_SERVICE"),
  smtpUser: optionalString("SMTP_USER"),
  smtpPass: optionalString("SMTP_PASS"),
  smtpFrom: optionalString("SMTP_FROM"),
  appWebUrl: optionalString("APP_WEB_URL"),
  publicAppUrl: optionalString("PUBLIC_APP_URL"),
  receptionistSetupUrl: optionalString("RECEPTIONIST_SETUP_URL"),
  mobileAppScheme: optionalString("MOBILE_APP_SCHEME") || "healthlink",
};

export type Env = typeof env;
