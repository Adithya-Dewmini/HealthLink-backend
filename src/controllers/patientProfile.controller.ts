import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { getPatientProfile, updatePatientProfile } from "../services/patientProfile.service";

type PatientProfileUpdateBody = {
  name?: string;
  email?: string;
  phone?: string;
  dob?: string;
  gender?: string;
  blood_group?: string;
  allergies?: string;
  conditions?: string;
  emergency_name?: string;
  emergency_phone?: string;
  nic?: string;
  address?: string;
  city?: string;
};

type HttpError = Error & { statusCode?: number };

const requirePatientUser = (req: AuthenticatedRequest) => {
  const userId = req.user?.id;
  const role = req.user?.role;

  if (!userId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  if (role !== "patient") {
    throw Object.assign(new Error("Only patients can access profile"), { statusCode: 403 });
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

export const getMe = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = requirePatientUser(req);
    const profile = await getPatientProfile(userId);
    return res.json(profile);
  } catch (error) {
    console.error("Error fetching patient profile:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const updateMe = async (
  req: AuthenticatedRequest<PatientProfileUpdateBody>,
  res: Response
) => {
  try {
    const userId = requirePatientUser(req);
    const profile = await updatePatientProfile(userId, req.body || {});
    return res.json(profile);
  } catch (error) {
    console.error("Error updating patient profile:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};
