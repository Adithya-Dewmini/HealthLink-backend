import type { NextFunction, Request, Response } from "express";

type RateLimitOptions = {
  keyPrefix: string;
  windowMs: number;
  max: number;
  message: string;
};

const buckets = new Map<string, { count: number; resetAt: number }>();

const buildKey = (prefix: string, req: Request) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  return `${prefix}:${ip}:${email}`;
};

const createRateLimit = (options: RateLimitOptions) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = buildKey(options.keyPrefix, req);
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + options.windowMs,
      });
      return next();
    }

    if (bucket.count >= options.max) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ message: options.message });
    }

    bucket.count += 1;
    buckets.set(key, bucket);
    return next();
  };
};

export const authLoginRateLimit = createRateLimit({
  keyPrefix: "auth:login",
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many login attempts. Please try again later.",
});

export const authSetPasswordRateLimit = createRateLimit({
  keyPrefix: "auth:set-password",
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many password setup attempts. Please try again later.",
});
