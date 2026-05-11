import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { listPatientPharmacies } from "../services/patientPharmacy.service";

export const getPatientPharmacies = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const data = await listPatientPharmacies({
      search: typeof req.query.search === "string" ? req.query.search : undefined,
    });

    return res.status(200).json(data);
  } catch (error) {
    const appError = error as { message?: string; code?: string };
    console.error("[patient:pharmacies]", {
      message: appError?.message || "Unknown error",
      code: appError?.code || null,
    });

    return res.status(500).json({
      message: "Failed to load pharmacies",
    });
  }
};
