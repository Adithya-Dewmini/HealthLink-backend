import type { Request, Response } from "express";
import { formatApiError } from "../../middleware/errorHandler";
import { fetchPharmacyProfileByUserId } from "../pharmacy/service";
import { HttpError, isHttpError } from "../pharmacy/errors";
import { assertVerifiedPharmacyForUser } from "../../services/verification.service";
import type { AuthenticatedRequest } from "../../types/auth";
import {
  getForecastForMedicine,
  getPharmacyAnalyticsDashboard,
} from "./service";

const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
  if (isHttpError(error)) {
    const formatted = formatApiError(error);
    return res.status(formatted.statusCode).json(formatted.body);
  }
  const typed = error as Error & { statusCode?: number };
  const formatted = formatApiError(
    Object.assign(new Error(typed.message || fallbackMessage), {
      statusCode: Number(typed.statusCode) || 500,
    })
  );
  return res.status(formatted.statusCode).json(formatted.body);
};

const requireVerifiedPharmacist = async (req: Request) => {
  const typedReq = req as AuthenticatedRequest;
  const userId = typedReq.user?.id;
  const role = String(typedReq.user?.role || "").toLowerCase();
  if (!userId) throw new HttpError(401, "Unauthorized");
  if (role !== "pharmacist") throw new HttpError(403, "Only pharmacists can access analytics");
  await assertVerifiedPharmacyForUser(Number(userId));
  return fetchPharmacyProfileByUserId(Number(userId));
};

export const getPharmacyAnalyticsDashboardController = async (req: Request, res: Response) => {
  try {
    const pharmacy = await requireVerifiedPharmacist(req);
    const data = await getPharmacyAnalyticsDashboard(pharmacy.id);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to load pharmacy analytics");
  }
};

export const getPharmacyForecastController = async (req: Request, res: Response) => {
  try {
    const pharmacy = await requireVerifiedPharmacist(req);
    const medicineId = Number(req.params.medicineId);
    if (!Number.isInteger(medicineId) || medicineId <= 0) {
      throw new HttpError(400, "Valid medicine id is required");
    }
    const data = await getForecastForMedicine(pharmacy.id, medicineId);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to load pharmacy forecast");
  }
};
