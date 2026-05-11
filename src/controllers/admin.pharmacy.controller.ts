import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { listAdminPharmacies } from "../services/admin-pharmacy.service";

type HttpError = Error & { statusCode?: number; code?: string };

const logAdminEndpointError = (endpoint: string, error: unknown) => {
  const appError = error as HttpError;
  console.error(`[admin:${endpoint}]`, {
    message: appError?.message || "Unknown error",
    code: appError?.code || null,
  });
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;

  return res.status(statusCode).json({
    message: appError?.message || fallbackMessage,
  });
};

export const listAdminPharmaciesController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const activityLevel =
      req.query.activity_level === "high" ||
      req.query.activity_level === "medium" ||
      req.query.activity_level === "low"
        ? req.query.activity_level
        : undefined;

    const data = await listAdminPharmacies({
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      verificationStatus:
        typeof req.query.verification_status === "string"
          ? req.query.verification_status
          : undefined,
      activityLevel,
      page: typeof req.query.page === "string" ? Number(req.query.page) : undefined,
      pageSize:
        typeof req.query.pageSize === "string"
          ? Number(req.query.pageSize)
          : typeof req.query.page_size === "string"
            ? Number(req.query.page_size)
            : undefined,
    });

    return res.status(200).json(data);
  } catch (error) {
    logAdminEndpointError("pharmacies", error);
    return handleControllerError(res, error, "Failed to load admin pharmacies");
  }
};
