import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  getPatientPrescriptionDetail,
  listPatientPrescriptions,
  markPatientPrescriptionSeen,
} from "../services/patientPrescription.service";
import { createAuditLog, getAuditRequestContext } from "../services/audit.service";

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

export const getPrescriptionDetail = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const patientId = requirePatientLikeUser(req);
    const prescriptionId = String(req.params.id || "").trim();

    if (!prescriptionId) {
      return res.status(400).json({ message: "Invalid prescription id" });
    }

    const prescription = await getPatientPrescriptionDetail(prescriptionId, patientId);
    await createAuditLog({
      ...getAuditRequestContext(req),
      userId: patientId,
      action: "prescription_accessed",
      entityType: "prescription",
      entityId: prescriptionId,
      metadata: {
        source: "patient_detail_view",
      },
    });
    return res.json(prescription);
  } catch (error) {
    console.error("Patient prescription detail error:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const markPrescriptionSeen = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const patientId = requirePatientLikeUser(req);
    const prescriptionId = String(req.params.id || "").trim();

    if (!prescriptionId) {
      return res.status(400).json({ message: "Invalid prescription id" });
    }

    await markPatientPrescriptionSeen(prescriptionId, patientId);
    await createAuditLog({
      ...getAuditRequestContext(req),
      userId: patientId,
      action: "prescription_seen",
      entityType: "prescription",
      entityId: prescriptionId,
    });
    return res.json({ success: true });
  } catch (error) {
    console.error("Mark prescription seen error:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};
