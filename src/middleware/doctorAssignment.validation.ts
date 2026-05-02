import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";

type HttpError = Error & { statusCode?: number };

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

const sendValidationError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  return res.status(Number(appError?.statusCode) || 400).json({
    message: appError?.message || fallbackMessage,
  });
};

const requireString = (value: unknown, field: string) => {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw createStatusError(`${field} is required`, 400);
  }

  return normalized;
};

export const validateInviteDoctorBody = (
  req: AuthenticatedRequest<{ email?: string; doctorId?: number | string }>,
  res: Response,
  next: NextFunction
) => {
  try {
    const rawDoctorId = req.body?.doctorId;
    const hasDoctorId = rawDoctorId !== undefined && String(rawDoctorId).trim() !== "";

    if (hasDoctorId) {
      const doctorId = Number(rawDoctorId);
      if (!Number.isInteger(doctorId) || doctorId <= 0) {
        throw createStatusError("doctorId must be a positive integer", 400);
      }

      req.body = { doctorId };
      next();
      return;
    }

    const email = requireString(req.body?.email, "email").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw createStatusError("Valid email is required", 400);
    }

    req.body = { email };
    next();
  } catch (error) {
    return sendValidationError(res, error, "Invalid doctor invite payload");
  }
};

export const validateAcceptDoctorInviteBody = (
  req: AuthenticatedRequest<{ token?: string }>,
  res: Response,
  next: NextFunction
) => {
  try {
    req.body = {
      token: requireString(req.body?.token, "token"),
    };
    next();
  } catch (error) {
    return sendValidationError(res, error, "Invalid doctor invite token");
  }
};

export const validateDoctorJoinRequestBody = (
  req: AuthenticatedRequest<{ medicalCenterId?: string }>,
  res: Response,
  next: NextFunction
) => {
  try {
    req.body = {
      medicalCenterId: requireString(req.body?.medicalCenterId, "medicalCenterId"),
    };
    next();
  } catch (error) {
    return sendValidationError(res, error, "Invalid doctor join request payload");
  }
};

export const validateDoctorRequestActionBody = (
  req: AuthenticatedRequest<{ action?: string }>,
  res: Response,
  next: NextFunction
) => {
  try {
    const action = requireString(req.body?.action, "action").toUpperCase();
    if (!["APPROVE", "REJECT"].includes(action)) {
      throw createStatusError("action must be APPROVE or REJECT", 400);
    }

    req.body = { action };
    next();
  } catch (error) {
    return sendValidationError(res, error, "Invalid doctor request review payload");
  }
};

export const validateDoctorRelationshipStatusBody = (
  req: AuthenticatedRequest<{ status?: string }>,
  res: Response,
  next: NextFunction
) => {
  try {
    const status = requireString(req.body?.status, "status").toUpperCase();
    if (!["ACTIVE", "INACTIVE"].includes(status)) {
      throw createStatusError("status must be ACTIVE or INACTIVE", 400);
    }

    req.body = { status };
    next();
  } catch (error) {
    return sendValidationError(res, error, "Invalid doctor relationship status payload");
  }
};
