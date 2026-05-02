import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  createMedicalCenterDoctor,
  deleteMedicalCenterDoctor,
  getMedicalCenterDashboard,
  listMedicalCenterAppointments,
  listMedicalCenterDoctors,
  listMedicalCenterQueues,
  updateMedicalCenterDoctor,
} from "../services/medicalCenter.service";

type MedicalCenterRequest<TBody = Record<string, unknown>> = AuthenticatedRequest<TBody>;

type DoctorBody = {
  name?: string;
  email?: string;
  password?: string;
  phone?: string;
  specialization?: string;
  licenseNumber?: string;
  experienceYears?: number | string | null;
};

type HttpError = Error & { statusCode?: number };

const requireMedicalCenterContext = (req: MedicalCenterRequest) => {
  const medicalCenterId = req.medicalCenterId;
  if (!medicalCenterId) {
    throw Object.assign(new Error("Medical center context missing"), { statusCode: 403 });
  }
  return medicalCenterId;
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;

  return res.status(statusCode).json({
    message: appError?.message || fallbackMessage,
  });
};

export const getDashboard = async (req: MedicalCenterRequest, res: Response) => {
  try {
    const medicalCenterId = requireMedicalCenterContext(req);
    const dashboard = await getMedicalCenterDashboard(medicalCenterId);
    return res.json(dashboard);
  } catch (error) {
    console.error("Medical center dashboard error:", error);
    return handleControllerError(res, error, "Failed to load center dashboard");
  }
};

export const getDoctors = async (req: MedicalCenterRequest, res: Response) => {
  try {
    const medicalCenterId = requireMedicalCenterContext(req);
    const doctors = await listMedicalCenterDoctors(medicalCenterId);
    return res.json(doctors);
  } catch (error) {
    console.error("Medical center doctors fetch error:", error);
    return handleControllerError(res, error, "Failed to load doctors");
  }
};

export const createDoctor = async (
  req: MedicalCenterRequest<DoctorBody>,
  res: Response
) => {
  try {
    const medicalCenterId = requireMedicalCenterContext(req);
    const { name, email, password, phone, specialization, licenseNumber, experienceYears } =
      req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email and password are required" });
    }

    const doctor = await createMedicalCenterDoctor({
      medicalCenterId,
      name,
      email,
      password,
      phone: phone || null,
      specialization: specialization || null,
      licenseNumber: licenseNumber || null,
      experienceYears: Number.isFinite(Number(experienceYears))
        ? Number(experienceYears)
        : null,
    });

    return res.status(201).json(doctor);
  } catch (error) {
    console.error("Medical center doctor create error:", error);
    return handleControllerError(res, error, "Failed to create doctor");
  }
};

export const updateDoctor = async (
  req: MedicalCenterRequest<DoctorBody>,
  res: Response
) => {
  try {
    const medicalCenterId = requireMedicalCenterContext(req);
    const doctorId = Number(req.params.id);

    if (!Number.isFinite(doctorId) || doctorId <= 0) {
      return res.status(400).json({ message: "Invalid doctor id" });
    }

    const { name, email, phone, specialization, licenseNumber, experienceYears } = req.body || {};

    const doctor = await updateMedicalCenterDoctor({
      medicalCenterId,
      doctorId,
      name: name || null,
      email: email || null,
      phone: phone || null,
      specialization: specialization || null,
      licenseNumber: licenseNumber || null,
      experienceYears: Number.isFinite(Number(experienceYears))
        ? Number(experienceYears)
        : null,
    });

    return res.json(doctor);
  } catch (error) {
    console.error("Medical center doctor update error:", error);
    return handleControllerError(res, error, "Failed to update doctor");
  }
};

export const deleteDoctor = async (req: MedicalCenterRequest, res: Response) => {
  try {
    const medicalCenterId = requireMedicalCenterContext(req);
    const doctorId = Number(req.params.id);

    if (!Number.isFinite(doctorId) || doctorId <= 0) {
      return res.status(400).json({ message: "Invalid doctor id" });
    }

    await deleteMedicalCenterDoctor(medicalCenterId, doctorId);
    return res.json({ message: "Doctor deleted" });
  } catch (error) {
    console.error("Medical center doctor delete error:", error);
    return handleControllerError(res, error, "Failed to delete doctor");
  }
};

export const getQueues = async (req: MedicalCenterRequest, res: Response) => {
  try {
    const medicalCenterId = requireMedicalCenterContext(req);
    const queues = await listMedicalCenterQueues(medicalCenterId);
    return res.json(queues);
  } catch (error) {
    console.error("Medical center queues fetch error:", error);
    return handleControllerError(res, error, "Failed to load queues");
  }
};

export const getAppointments = async (req: MedicalCenterRequest, res: Response) => {
  try {
    const medicalCenterId = requireMedicalCenterContext(req);
    const appointments = await listMedicalCenterAppointments(medicalCenterId);
    return res.json(appointments);
  } catch (error) {
    console.error("Medical center appointments fetch error:", error);
    return handleControllerError(res, error, "Failed to load appointments");
  }
};
