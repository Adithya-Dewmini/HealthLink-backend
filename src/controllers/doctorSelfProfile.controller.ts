import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  getDoctorSelfProfile,
  updateDoctorSelfProfile,
} from "../services/doctorSelfProfile.service";

type DoctorSelfProfileUpdateBody = {
  name?: string;
  phone?: string;
  specialization?: string;
  experience_years?: string | number;
  bio?: string;
  qualifications?: string;
  consultation_fee?: string | number;
};

type HttpError = Error & { statusCode?: number };

const requireDoctorUser = (req: AuthenticatedRequest) => {
  const userId = req.user?.id;
  const role = String(req.user?.role || "").trim().toLowerCase();

  if (!userId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  if (role !== "doctor") {
    throw Object.assign(new Error("Only doctors can access profile"), { statusCode: 403 });
  }

  return userId;
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;

  return res.status(statusCode).json({
    message: appError?.message || fallbackMessage,
  });
};

export const getDoctorMeController = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = requireDoctorUser(req);
    const profile = await getDoctorSelfProfile(userId);
    return res.json(profile);
  } catch (error) {
    console.error("Error fetching doctor profile:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const updateDoctorMeController = async (
  req: AuthenticatedRequest<DoctorSelfProfileUpdateBody>,
  res: Response
) => {
  try {
    const userId = requireDoctorUser(req);
    const profile = await updateDoctorSelfProfile(userId, req.body || {});
    return res.json(profile);
  } catch (error) {
    console.error("Error updating doctor profile:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};
