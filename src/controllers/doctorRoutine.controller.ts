import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { listDoctorRoutines } from "../services/schedule.service";

const unavailable = (res: Response) =>
  res.status(503).json({ message: "Doctor routine endpoints are temporarily disabled" });

const getDoctorUserId = (req: AuthenticatedRequest) => {
  if (!req.user?.id) {
    const error = new Error("Unauthorized") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
  if (String(req.user.role || "").toLowerCase() !== "doctor") {
    const error = new Error("Only doctors can access this resource") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
  return req.user.id;
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as Error & { statusCode?: number };
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
};

export const getDoctorRoutineController: RequestHandler = async (req, res) => {
  try {
    const userId = getDoctorUserId(req as AuthenticatedRequest);
    const routines = await listDoctorRoutines(userId);
    return res.status(200).json(routines);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load doctor routines");
  }
};

export const createDoctorRoutineController: RequestHandler = async (_req, res: Response) =>
  unavailable(res);
