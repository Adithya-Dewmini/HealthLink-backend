import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { listPatientMedicalHistory } from "../services/patientMedicalHistory.service";

type HttpError = Error & { statusCode?: number };

const requirePatientLikeUser = (req: AuthenticatedRequest) => {
  const role = req.user?.role;
  const patientId = req.user?.id;

  if (role !== "patient" && role !== "user") {
    throw Object.assign(new Error("Only patients can access medical history"), {
      statusCode: 403,
    });
  }

  if (!patientId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  return patientId;
};

export const getMedicalHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const patientId = requirePatientLikeUser(req);
    const items = await listPatientMedicalHistory(patientId);
    return res.json({ items });
  } catch (error) {
    const appError = error as HttpError;
    const statusCode = Number(appError?.statusCode) || 500;
    console.error("Patient medical history error:", error);
    return res.status(statusCode).json({
      message: appError?.message || "Failed to load medical history",
    });
  }
};
