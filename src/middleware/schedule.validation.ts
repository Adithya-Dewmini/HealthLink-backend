import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";

type ScheduleBody = {
  doctor_id?: unknown;
  date?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  slot_duration?: unknown;
  max_patients?: unknown;
  is_active?: unknown;
};

const isPositiveIntegerLike = (value: unknown) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
};

const isTimeLike = (value: unknown) =>
  typeof value === "string" && /^\d{2}:\d{2}(:\d{2})?$/.test(value.trim());

const isDateLike = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());

const sendValidationError = (res: Response, message: string) =>
  res.status(400).json({ message });

export const validateCreateScheduleBody = (
  req: AuthenticatedRequest<ScheduleBody>,
  res: Response,
  next: NextFunction
) => {
  const body = req.body || {};

  if (!isPositiveIntegerLike(body.doctor_id)) {
    return sendValidationError(res, "doctor_id must be a positive integer");
  }

  if (!isDateLike(body.date)) {
    return sendValidationError(res, "date must be in YYYY-MM-DD format");
  }

  if (!isTimeLike(body.start_time) || !isTimeLike(body.end_time)) {
    return sendValidationError(res, "start_time and end_time must be in HH:MM format");
  }

  if (!isPositiveIntegerLike(body.slot_duration)) {
    return sendValidationError(res, "slot_duration must be a positive integer");
  }

  if (!isPositiveIntegerLike(body.max_patients)) {
    return sendValidationError(res, "max_patients must be a positive integer");
  }

  return next();
};

export const validateUpdateScheduleBody = (
  req: AuthenticatedRequest<ScheduleBody>,
  res: Response,
  next: NextFunction
) => {
  const body = req.body || {};

  if (body.doctor_id !== undefined && !isPositiveIntegerLike(body.doctor_id)) {
    return sendValidationError(res, "doctor_id must be a positive integer");
  }

  if (body.date !== undefined && !isDateLike(body.date)) {
    return sendValidationError(res, "date must be in YYYY-MM-DD format");
  }

  if (body.start_time !== undefined && !isTimeLike(body.start_time)) {
    return sendValidationError(res, "start_time must be in HH:MM format");
  }

  if (body.end_time !== undefined && !isTimeLike(body.end_time)) {
    return sendValidationError(res, "end_time must be in HH:MM format");
  }

  if (body.slot_duration !== undefined && !isPositiveIntegerLike(body.slot_duration)) {
    return sendValidationError(res, "slot_duration must be a positive integer");
  }

  if (body.max_patients !== undefined && !isPositiveIntegerLike(body.max_patients)) {
    return sendValidationError(res, "max_patients must be a positive integer");
  }

  if (body.is_active !== undefined && typeof body.is_active !== "boolean") {
    return sendValidationError(res, "is_active must be a boolean");
  }

  return next();
};
