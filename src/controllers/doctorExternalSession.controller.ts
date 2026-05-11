import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  createDoctorExternalSession,
  deleteDoctorExternalSession,
  listDoctorExternalSessions,
} from "../services/doctorExternalSession.service";

type HttpError = Error & { statusCode?: number };

type ExternalSessionBody = {
  dayOfWeek?: number | string;
  startTime?: string;
  endTime?: string;
  clinicName?: string;
  note?: string;
};

const getDoctorUserId = (req: AuthenticatedRequest) => {
  if (!req.user?.id) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  if (String(req.user.role || "").toLowerCase() !== "doctor") {
    throw Object.assign(new Error("Only doctors can access this resource"), { statusCode: 403 });
  }

  return Number(req.user.id);
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
};

export const listDoctorExternalSessionsController: RequestHandler = async (req, res) => {
  try {
    const doctorUserId = getDoctorUserId(req as AuthenticatedRequest);
    const sessions = await listDoctorExternalSessions(doctorUserId);
    return res.status(200).json(sessions);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load external sessions");
  }
};

export const createDoctorExternalSessionController: RequestHandler = async (req, res) => {
  const typedReq = req as AuthenticatedRequest<ExternalSessionBody>;

  try {
    const doctorUserId = getDoctorUserId(typedReq);
    const result = await createDoctorExternalSession({
      doctorUserId,
      dayOfWeek: Number(typedReq.body?.dayOfWeek),
      startTime: String(typedReq.body?.startTime || ""),
      endTime: String(typedReq.body?.endTime || ""),
      clinicName: String(typedReq.body?.clinicName || ""),
      note: typedReq.body?.note,
    });
    return res.status(201).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to create external session");
  }
};

export const deleteDoctorExternalSessionController: RequestHandler = async (req, res) => {
  try {
    const doctorUserId = getDoctorUserId(req as AuthenticatedRequest);
    const externalSessionId = Number(req.params.externalSessionId);
    const sessions = await deleteDoctorExternalSession(doctorUserId, externalSessionId);
    return res.status(200).json(sessions);
  } catch (error) {
    return handleControllerError(res, error, "Failed to delete external session");
  }
};
