import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  getDoctorPrescriptionDetail,
  listDoctorPrescriptions,
} from "../services/doctorPrescription.service";

type HttpError = Error & { statusCode?: number };

const requireDoctorUser = (req: AuthenticatedRequest) => {
  if (!req.user?.id) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  if (String(req.user.role || "").toLowerCase() !== "doctor") {
    throw Object.assign(new Error("Only doctors can access prescriptions"), {
      statusCode: 403,
    });
  }

  return req.user.id;
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;

  return res.status(statusCode).json({
    message: appError?.message || fallbackMessage,
  });
};

export const listDoctorPrescriptionsController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const doctorUserId = requireDoctorUser(req);
    const prescriptions = await listDoctorPrescriptions(doctorUserId, {
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      date: typeof req.query.date === "string" ? req.query.date : undefined,
      limit:
        typeof req.query.limit === "string" && req.query.limit.trim()
          ? Number(req.query.limit)
          : undefined,
      offset:
        typeof req.query.offset === "string" && req.query.offset.trim()
          ? Number(req.query.offset)
          : undefined,
    });
    return res.json(prescriptions);
  } catch (error) {
    console.error("Doctor prescriptions list error:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const getDoctorPrescriptionDetailController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const doctorUserId = requireDoctorUser(req);
    const prescriptionId = String(req.params.prescriptionId || "").trim();

    if (!prescriptionId) {
      return res.status(400).json({ message: "Invalid prescription id" });
    }

    const prescription = await getDoctorPrescriptionDetail(doctorUserId, prescriptionId);
    return res.json(prescription);
  } catch (error) {
    console.error("Doctor prescription detail error:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};
