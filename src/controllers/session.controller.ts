import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { getDoctorMonthlySchedule, createClinicSession } from "../services/session.service";

type HttpError = Error & { statusCode?: number };

type CreateSessionBody = {
  doctorId?: number | string;
  date?: string;
  startTime?: string;
  endTime?: string;
  maxPatients?: number | string;
};

const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
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

export const getDoctorScheduleController: RequestHandler = async (req, res) => {
  try {
    const doctorUserId = getDoctorUserId(req as AuthenticatedRequest);
    const month = typeof req.query.month === "string" ? req.query.month : "";
    const schedule = await getDoctorMonthlySchedule(doctorUserId, month);
    return res.status(200).json(schedule);
  } catch (error) {
    return handleError(res, error, "Failed to load doctor schedule");
  }
};

export const createCenterSessionController: RequestHandler = async (req, res) => {
  const typedReq = req as AuthenticatedRequest<CreateSessionBody>;

  try {
    const role = String(typedReq.user?.role || "").toLowerCase();
    const scopedCenterId =
      typeof typedReq.user?.medicalCenterId === "string" ? typedReq.user.medicalCenterId : null;
    const paramCenterId = String(typedReq.params.centerId || "");

    if (!typedReq.user?.id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (role !== "medical_center_admin") {
      return res.status(403).json({ message: "Medical center admin access required" });
    }

    if (!scopedCenterId || scopedCenterId !== paramCenterId) {
      return res.status(403).json({ message: "Medical center access denied" });
    }

    const session = await createClinicSession({
      centerId: paramCenterId,
      doctorId: Number(typedReq.body?.doctorId),
      date: String(typedReq.body?.date || ""),
      startTime: String(typedReq.body?.startTime || ""),
      endTime: String(typedReq.body?.endTime || ""),
      maxPatients: Number(typedReq.body?.maxPatients),
      createdByUserId: Number(typedReq.user.id),
    });

    return res.status(201).json(session);
  } catch (error) {
    return handleError(res, error, "Failed to create clinic session");
  }
};
