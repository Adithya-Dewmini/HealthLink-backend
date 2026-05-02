import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  listPatientPrescriptions,
  markPatientPrescriptionSeen,
} from "../services/patientPrescription.service";

type HttpError = Error & { statusCode?: number };

const requirePatientLikeUser = (req: AuthenticatedRequest) => {
  const role = req.user?.role;
  const patientId = req.user?.id;

  if (role !== "patient" && role !== "user") {
    throw Object.assign(new Error("Only patients can access prescriptions"), {
      statusCode: 403,
    });
  }

  if (!patientId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  return patientId;
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;

  return res.status(statusCode).json({
    message: appError?.message || fallbackMessage,
  });
};

export const getPrescriptions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const patientId = requirePatientLikeUser(req);
    const latest = String(req.query?.latest ?? "") === "true";
    const prescriptions = await listPatientPrescriptions(patientId, latest);
    return res.json(prescriptions);
  } catch (error) {
    console.error("Patient prescriptions error:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const markPrescriptionSeen = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const patientId = requirePatientLikeUser(req);
    const prescriptionId = Number(req.params.id);

    if (!prescriptionId) {
      return res.status(400).json({ message: "Invalid prescription id" });
    }

    await markPatientPrescriptionSeen(prescriptionId, patientId);
    return res.json({ success: true });
  } catch (error) {
    console.error("Mark prescription seen error:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};
