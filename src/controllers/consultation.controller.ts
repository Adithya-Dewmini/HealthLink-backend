import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  completeConsultationRecord,
  createConsultationRecord,
  getDoctorConsultationContext,
  searchMedicines,
  updateConsultationMedicines,
  updateConsultationRecord,
} from "../services/consultation.service";

type ConsultationBody = {
  patientId?: number;
  queueId?: number | null;
  symptoms?: string | null;
  diagnosis?: string | null;
  notes?: string | null;
  medicines?: any[];
};

type MedicineBody = {
  medicines?: any[];
};

type HttpError = Error & { statusCode?: number; conflicts?: unknown };

const requireDoctorUser = (req: AuthenticatedRequest) => {
  const userId = req.user?.id;
  const role = req.user?.role;

  if (!userId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  if (role !== "doctor") {
    throw Object.assign(new Error("Only doctors can access this resource"), {
      statusCode: 403,
    });
  }

  return userId;
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;
  const payload: Record<string, unknown> = {
    message: appError?.message || fallbackMessage,
  };

  if (appError?.conflicts) {
    payload.conflicts = appError.conflicts;
  }

  return res.status(statusCode).json(payload);
};

export const getMedicines = async (req: AuthenticatedRequest, res: Response) => {
  try {
    requireDoctorUser(req);
    const q = String(req.query?.q || "").trim();
    const limit = Number(req.query?.limit || 20);
    const medicines = await searchMedicines(q, limit);
    return res.json({ medicines });
  } catch (error) {
    console.error("Search medicines error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const getDoctorConsultation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = requireDoctorUser(req);
    const queueId = Number(req.params.queueId);
    if (!queueId) {
      return res.status(400).json({ message: "queueId is required" });
    }

    const context = await getDoctorConsultationContext(queueId, userId);
    return res.json(context);
  } catch (error) {
    console.error("Doctor consultation fetch error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const createConsultation = async (
  req: AuthenticatedRequest<ConsultationBody>,
  res: Response
) => {
  try {
    const userId = requireDoctorUser(req);
    const { patientId, queueId, symptoms, diagnosis, notes, medicines } = req.body || {};

    if (!patientId) {
      return res.status(400).json({ message: "patientId is required" });
    }

    const consultation = await createConsultationRecord({
      userId,
      patientId,
      queueId: queueId ?? null,
      symptoms: symptoms ?? null,
      diagnosis: diagnosis ?? null,
      notes: notes ?? null,
      medicines,
    });

    return res.json({ consultation });
  } catch (error) {
    console.error("Create consultation error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const saveConsultationMedicines = async (
  req: AuthenticatedRequest<MedicineBody>,
  res: Response
) => {
  try {
    requireDoctorUser(req);
    const consultation = await updateConsultationMedicines(req.params.id, req.body?.medicines ?? []);
    return res.json({ consultation });
  } catch (error) {
    console.error("Update medicines error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const updateConsultation = async (
  req: AuthenticatedRequest<ConsultationBody>,
  res: Response
) => {
  try {
    const userId = requireDoctorUser(req);
    const consultation = await updateConsultationRecord({
      consultationId: req.params.id,
      userId,
      symptoms: req.body?.symptoms ?? null,
      diagnosis: req.body?.diagnosis ?? null,
      notes: req.body?.notes ?? null,
      medicines: req.body?.medicines,
    });

    return res.json({ consultation });
  } catch (error) {
    console.error("Update consultation error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const completeConsultation = async (
  req: AuthenticatedRequest<MedicineBody>,
  res: Response
) => {
  try {
    const userId = requireDoctorUser(req);
    const result = await completeConsultationRecord(req.params.id, userId, req.body?.medicines);
    return res.json(result);
  } catch (error) {
    console.error("Complete consultation error:", error);
    return handleControllerError(res, error, "Failed to complete consultation");
  }
};
