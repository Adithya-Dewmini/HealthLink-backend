import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { listAdminDoctors } from "../services/admin-doctor.service";

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

export const listAdminDoctorsController = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await listAdminDoctors({
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      specialization:
        typeof req.query.specialization === "string" ? req.query.specialization : undefined,
      verificationStatus:
        typeof req.query.verification_status === "string"
          ? req.query.verification_status
          : undefined,
      isActive:
        req.query.is_active === "true" || req.query.is_active === "false"
          ? req.query.is_active
          : undefined,
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
    logAdminEndpointError("doctors", error);
    return handleControllerError(res, error, "Failed to load admin doctors");
  }
};
