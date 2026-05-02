import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { getDoctorDirectoryProfile, searchDoctorsDirectory } from "../services/doctor.service";

type HttpError = Error & { statusCode?: number };

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
};

export const searchDoctorsDirectoryController: RequestHandler = async (req, res: Response) => {
  try {
    const query = typeof req.query.query === "string" ? req.query.query : undefined;
    const specialization =
      typeof req.query.specialization === "string" ? req.query.specialization : undefined;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const offset = typeof req.query.offset === "string" ? Number(req.query.offset) : undefined;

    const doctors = await searchDoctorsDirectory({
      query,
      specialization,
      limit,
      offset,
      includeEmail: false,
    });

    return res.status(200).json(doctors);
  } catch (error) {
    return handleControllerError(res, error, "Failed to search doctors");
  }
};

export const getDoctorDirectoryProfileController: RequestHandler = async (
  req,
  res: Response
) => {
  try {
    const profile = await getDoctorDirectoryProfile(String(req.params.id || ""));
    return res.status(200).json(profile);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load doctor profile");
  }
};
