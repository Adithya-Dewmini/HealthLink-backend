import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { getPatientActiveQueueState } from "../services/patientBooking.service";

type HttpError = Error & { statusCode?: number; code?: string };

const requirePatientUser = (req: AuthenticatedRequest) => {
  const role = req.user?.role;
  const patientId = req.user?.id;

  if (role !== "patient" && role !== "user") {
    throw Object.assign(new Error("Only patients can access this resource"), {
      statusCode: 403,
    });
  }

  if (!patientId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  return patientId;
};

const toPositiveNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  return res.status(Number(appError?.statusCode) || 500).json({
    success: false,
    code: appError?.code || null,
    message: appError?.message || fallbackMessage,
  });
};

export const getPatientActiveQueueController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const patientId = requirePatientUser(req);
    const appointmentId = toPositiveNumber(req.query.appointmentId);
    const sessionId = toPositiveNumber(req.query.sessionId);

    return res.json(
      await getPatientActiveQueueState(patientId, {
        appointmentId,
        sessionId,
      })
    );
  } catch (error) {
    console.error("Patient active queue error:", error);
    return handleControllerError(res, error, "Failed to load queue status");
  }
};
