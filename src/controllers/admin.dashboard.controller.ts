import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  getAdminActivitySummary,
  getAdminAlerts,
  getAdminDashboardData,
  getAdminIntelligence,
} from "../services/admin.dashboard.service";

type HttpError = Error & { statusCode?: number };

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;

  return res.status(statusCode).json({
    message: appError?.message || fallbackMessage,
  });
};

export const getAdminDashboardController = async (
  _req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const data = await getAdminDashboardData();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Admin dashboard error:", error);
    return handleControllerError(res, error, "Failed to load dashboard");
  }
};

export const getAdminAlertsController = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await getAdminAlerts();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Admin alerts error:", error);
    return handleControllerError(res, error, "Failed to load admin alerts");
  }
};

export const getAdminActivitySummaryController = async (
  _req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const data = await getAdminActivitySummary();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Admin activity summary error:", error);
    return handleControllerError(res, error, "Failed to load activity summary");
  }
};

export const getAdminIntelligenceController = async (
  _req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const data = await getAdminIntelligence();
    return res.status(200).json(data);
  } catch (error) {
    console.error("Admin intelligence error:", error);
    return handleControllerError(res, error, "Failed to load intelligence dashboard");
  }
};
