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
  cloudinaryName: optionalString("CLOUDINARY_NAME"),
  cloudinaryKey: optionalString("CLOUDINARY_KEY"),
  cloudinarySecret: optionalString("CLOUDINARY_SECRET"),
  pgSsl: optionalBoolean("PG_SSL", databaseUrl.includes("sslmode=require")),
  pgConnectTimeoutMs: optionalNumber("PG_CONNECT_TIMEOUT_MS", 30000) ?? 30000,
  pgIdleTimeoutMs: optionalNumber("PG_IDLE_TIMEOUT_MS", 30000) ?? 30000,
  pgPoolMin: optionalNumber("PG_POOL_MIN", 0) ?? 0,
  pgPoolMax: optionalNumber("PG_POOL_MAX", 10) ?? 10,
  pgKeepAliveQueryMs: optionalNumber("PG_KEEP_ALIVE_QUERY_MS", 60000) ?? 60000,
  pgQueryRetry: optionalNumber("PG_QUERY_RETRY", 2) ?? 2,
  geminiApiKey: optionalString("GEMINI_API_KEY"),
  aiAssistantEnabled: optionalBoolean("AI_ASSISTANT_ENABLED", false),
  openaiApiKey: optionalString("OPENAI_API_KEY"),
  openaiModel: optionalString("OPENAI_MODEL") || "gpt-4.1-mini",
  smtpHost: optionalString("SMTP_HOST"),
  smtpPort: optionalNumber("SMTP_PORT", 587) ?? 587,
  smtpSecure: optionalBoolean("SMTP_SECURE", false),
  smtpService: optionalString("SMTP_SERVICE"),
  smtpUser: optionalString("SMTP_USER"),
  smtpPass: optionalString("SMTP_PASS"),
  smtpFrom: optionalString("SMTP_FROM"),
  appWebUrl: optionalString("APP_WEB_URL"),
  publicAppUrl: optionalString("PUBLIC_APP_URL"),
  allowedOrigins: (optionalString("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  rateLimitWindowMs: optionalNumber("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000) ?? 15 * 60 * 1000,
  rateLimitMaxRequests: optionalNumber("RATE_LIMIT_MAX_REQUESTS", 500) ?? 500,
  forecastServiceUrl: optionalString("FORECAST_SERVICE_URL"),
  receptionistSetupUrl: optionalString("RECEPTIONIST_SETUP_URL"),
  mobileAppScheme: optionalString("MOBILE_APP_SCHEME") || "healthlink",
  queueLateCheckInAction: optionalString("QUEUE_LATE_CHECK_IN_ACTION") || "move_to_end",
  payHereMerchantId: optionalString("PAYHERE_MERCHANT_ID"),
  payHereMerchantSecret: optionalString("PAYHERE_MERCHANT_SECRET"),
  payHereBaseUrl: optionalString("PAYHERE_BASE_URL"),
  payHereReturnUrl: optionalString("PAYHERE_RETURN_URL"),
  payHereCancelUrl: optionalString("PAYHERE_CANCEL_URL"),
  payHereNotifyUrl: optionalString("PAYHERE_NOTIFY_URL"),
  paymentGatewayMode:
    optionalString("PAYMENT_GATEWAY_MODE")?.toLowerCase() === "live" ? "live" : "sandbox",
};

export type Env = typeof env;
