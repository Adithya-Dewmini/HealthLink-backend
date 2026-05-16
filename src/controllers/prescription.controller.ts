import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  dispensePrescription,
  getPrescriptionDetails,
  verifyPrescriptionToken,
} from "../services/prescription.service";

type HttpError = Error & { statusCode?: number };

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;

  return res.status(statusCode).json({
    message: appError?.message || fallbackMessage,
  });
};

export const verifyPrescription = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await verifyPrescriptionToken(req.params.token);
    return res.json({ valid: true, ...result });
  } catch (error) {
    const appError = error as HttpError;
    if (Number(appError?.statusCode) === 404) {
      return res.status(404).json({ valid: false, error: appError.message });
    }
    return res.status(401).json({ valid: false, error: "Expired or invalid QR" });
  }
};

export const getPrescription = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const prescription = await getPrescriptionDetails(req.params.id, req.user);
    return res.json(prescription);
  } catch (error) {
    console.error("Get prescription error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const dispense = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const role = req.user?.role;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (role !== "pharmacist") {
      return res.status(403).json({ message: "Only pharmacists can dispense" });
    }

    const prescription = await dispensePrescription(req.params.id, userId);
    return res.json({ success: true, prescription });
  } catch (error) {
    console.error("Dispense error:", error);
    return handleControllerError(res, error, "Server error");
  }
};
