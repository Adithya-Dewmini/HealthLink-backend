import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  getClinicDetailsForPatient,
  getClinicDoctorScheduleForPatient,
  listClinicDoctorsForPatient,
  listClinicsForPatient,
} from "../services/patientClinic.service";

type HttpError = Error & { statusCode?: number };

const requirePatientLikeUser = (req: AuthenticatedRequest) => {
  const role = req.user?.role;
  if (role !== "patient" && role !== "user") {
    throw Object.assign(new Error("Only patients can access this resource"), {
      statusCode: 403,
    });
  }
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
};

export const getClinicDoctors = async (req: AuthenticatedRequest, res: Response) => {
  try {
    requirePatientLikeUser(req);
    const clinicId = String(req.params.clinicId || "").trim();
    if (!clinicId) {
      return res.status(400).json({ message: "clinicId is required" });
    }

    const data = await listClinicDoctorsForPatient(clinicId);
    return res.json(data);
  } catch (error) {
    console.error("Clinic doctors fetch error:", error);
    return handleControllerError(res, error, "Failed to load clinic doctors");
  }
};

export const getClinics = async (req: AuthenticatedRequest, res: Response) => {
  try {
    requirePatientLikeUser(req);
    const data = await listClinicsForPatient();
    return res.json(data);
  } catch (error) {
    console.error("Clinics fetch error:", error);
    return handleControllerError(res, error, "Failed to load medical centers");
  }
};

export const getClinicDetails = async (req: AuthenticatedRequest, res: Response) => {
  try {
    requirePatientLikeUser(req);
    const clinicId = String(req.params.clinicId || "").trim();
    if (!clinicId) {
      return res.status(400).json({ message: "clinicId is required" });
    }

    const data = await getClinicDetailsForPatient(clinicId);
    return res.json(data);
  } catch (error) {
    console.error("Clinic details fetch error:", error);
    return handleControllerError(res, error, "Failed to load medical center details");
  }
};

export const getClinicDoctorSchedule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    requirePatientLikeUser(req);
    const clinicId = String(req.params.clinicId || "").trim();
    const doctorId = Number(req.params.doctorId);

    if (!clinicId || !Number.isFinite(doctorId) || doctorId <= 0) {
      return res.status(400).json({ message: "Valid clinicId and doctorId are required" });
    }

    const data = await getClinicDoctorScheduleForPatient(clinicId, doctorId);
    return res.json(data);
  } catch (error) {
    console.error("Clinic doctor schedule fetch error:", error);
    return handleControllerError(res, error, "Failed to load clinic schedule");
  }
};
