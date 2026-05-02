import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";

const sendValidationError = (res: Response, message: string) =>
  res.status(400).json({ message });

export const validateDoctorSearchQuery = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const { limit, offset } = req.query;

  if (limit !== undefined) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      return sendValidationError(res, "limit must be a positive integer");
    }
  }

  if (offset !== undefined) {
    const parsedOffset = Number(offset);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      return sendValidationError(res, "offset must be a non-negative integer");
    }
  }

  return next();
};

export const validateDoctorDirectoryIdParam = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const parsedId = Number(req.params.id);
  if (!Number.isInteger(parsedId) || parsedId <= 0) {
    return sendValidationError(res, "Invalid doctor id");
  }

  return next();
};
