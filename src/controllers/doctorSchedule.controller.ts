import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { getDoctorScheduleOverview } from "../services/schedule.service";

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

export const getDoctorScheduleOverviewController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as AuthenticatedRequest;

  try {
    const doctorUserId = getDoctorUserId(typedReq);
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const overview = await getDoctorScheduleOverview(doctorUserId, { from, to });
    return res.status(200).json(overview);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load schedule overview");
  }
};
