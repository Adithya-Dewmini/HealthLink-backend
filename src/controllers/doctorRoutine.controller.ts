import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  createDoctorRoutine,
  getDoctorRoutine,
} from "../services/doctorRoutine.service";

type HttpError = Error & { statusCode?: number };

const getDoctorUserId = (req: AuthenticatedRequest) => {
  if (!req.user?.id) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  if (req.user.role !== "doctor") {
    throw Object.assign(new Error("Only doctors can access this resource"), {
      statusCode: 403,
    });
  }

  return req.user.id;
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
};

export const getDoctorRoutineController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as AuthenticatedRequest;

  try {
    const doctorUserId = getDoctorUserId(typedReq);
    const routine = await getDoctorRoutine(doctorUserId);
    return res.status(200).json(routine);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load routine");
  }
};

export const createDoctorRoutineController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as AuthenticatedRequest;

  try {
    const doctorUserId = getDoctorUserId(typedReq);
    const clinicId = String(req.body?.clinicId || "").trim();
    const dayOfWeek = Number(req.body?.dayOfWeek);
    const startTime = String(req.body?.startTime || "").trim();
    const endTime = String(req.body?.endTime || "").trim();

    if (!clinicId) {
      throw Object.assign(new Error("clinicId is required"), { statusCode: 400 });
    }

    const routine = await createDoctorRoutine(doctorUserId, {
      clinicId,
      dayOfWeek,
      startTime,
      endTime,
    });

    return res.status(201).json(routine);
  } catch (error) {
    return handleControllerError(res, error, "Failed to save routine");
  }
};
