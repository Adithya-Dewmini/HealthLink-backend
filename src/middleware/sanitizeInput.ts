import type { NextFunction, Request, Response } from "express";

const sanitizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.startsWith("$") && !key.includes("."))
      .map(([key, nested]) => [key, sanitizeValue(nested)]);
    return Object.fromEntries(entries);
  }

  if (typeof value === "string") {
    return value.replace(/\0/g, "").trim();
  }

  return value;
};

const sanitizeObjectInPlace = (target: Record<string, unknown>) => {
  const sanitized = sanitizeValue(target);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return;
  }

  for (const key of Object.keys(target)) {
    delete target[key];
  }

  Object.assign(target, sanitized);
};

export const sanitizeInput = (req: Request, _res: Response, next: NextFunction) => {
  if (req.body && typeof req.body === "object") {
    req.body = sanitizeValue(req.body) as Record<string, unknown>;
  }

  if (req.query && typeof req.query === "object" && !Array.isArray(req.query)) {
    sanitizeObjectInPlace(req.query as Record<string, unknown>);
  }

  next();
};
