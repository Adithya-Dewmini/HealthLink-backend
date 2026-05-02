import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  getDoctorQueueStatusForPatient,
  joinDoctorQueueForPatient,
  listDoctorAvailabilityForPatient,
  listDoctorsForPatient,
  listDoctorWorkingDaysForPatient,
} from "../services/patientDoctor.service";

type QueueJoinBody = {
  doctor_id?: number | string;
};

type HttpError = Error & { statusCode?: number };

const requirePatientLikeUser = (req: AuthenticatedRequest) => {
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

const requireStrictPatient = (req: AuthenticatedRequest) => {
  const role = req.user?.role;
  if (role !== "patient") {
    throw Object.assign(new Error("Only patients can access this resource"), {
      statusCode: 403,
    });
  }
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;

  return res.status(statusCode).json({
    message: appError?.message || fallbackMessage,
  });
};

export const getDoctorAvailability = async (req: AuthenticatedRequest, res: Response) => {
  try {
    requireStrictPatient(req);
    const { doctorId } = req.params;
    const rows = await listDoctorAvailabilityForPatient(doctorId);
    return res.json(rows);
  } catch (error) {
    console.error("Error fetching doctor availability:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const getDoctorWorkingDays = async (req: AuthenticatedRequest, res: Response) => {
  try {
    requireStrictPatient(req);
    const { doctorId } = req.params;
    const days = await listDoctorWorkingDaysForPatient(doctorId);
    return res.json(days);
  } catch (error) {
    console.error("Error fetching doctor working days:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const getDoctorQueueStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const patientId = requirePatientLikeUser(req);
    const { doctorId } = req.params;
    const status = await getDoctorQueueStatusForPatient(doctorId, patientId);
    return res.json(status);
  } catch (error) {
    console.error("Error fetching queue status:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const joinQueue = async (
  req: AuthenticatedRequest<QueueJoinBody>,
  res: Response
) => {
  try {
    const patientId = requirePatientLikeUser(req);
    const { doctor_id } = req.body || {};

    if (!doctor_id) {
      return res.status(400).json({ message: "doctor_id is required" });
    }

    const result = await joinDoctorQueueForPatient(doctor_id, patientId, req.user?.role);
    return res.json(result);
  } catch (error) {
    console.error("Join queue error:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const getDoctors = async (req: AuthenticatedRequest, res: Response) => {
  try {
    requirePatientLikeUser(req);
    const doctors = await listDoctorsForPatient();
    return res.json(doctors);
  } catch (error) {
    console.error("Error fetching doctors:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};
