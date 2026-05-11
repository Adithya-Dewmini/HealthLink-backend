import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import type { CorsOptions } from "cors";
import { env } from "../config/env";

const allowedOrigins = new Set(env.allowedOrigins);

const isOriginAllowed = (origin: string | undefined) => {
  if (!origin) return true;
  if (!allowedOrigins.size) return true;
  return allowedOrigins.has(origin);
};

export const corsMiddleware = cors({
  origin(origin, callback) {
    if (isOriginAllowed(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin not allowed by CORS policy"));
  },
  credentials: true,
} satisfies CorsOptions);

export const securityHeaders = helmet({
  crossOriginResourcePolicy: false,
});

export const apiRateLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  max: env.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "rate_limit_exceeded",
      message: "Too many requests. Please try again later.",
    },
  },
});
