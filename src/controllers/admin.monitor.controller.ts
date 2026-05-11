import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  getAdminMonitorBookings,
  getAdminMonitorPrescriptions,
  getAdminMonitorQueues,
  getAdminMonitorSessions,
} from "../services/admin-monitor.service";

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

export const listAdminMonitorQueuesController = async (
  _req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const data = await getAdminMonitorQueues();
    return res.status(200).json(data);
  } catch (error) {
    logAdminEndpointError("monitor/queues", error);
    return handleControllerError(res, error, "Failed to load admin queue monitoring");
  }
};

export const listAdminMonitorSessionsController = async (
  _req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const data = await getAdminMonitorSessions();
    return res.status(200).json(data);
  } catch (error) {
    logAdminEndpointError("monitor/sessions", error);
    return handleControllerError(res, error, "Failed to load admin session monitoring");
  }
};

export const getAdminMonitorBookingsController = async (
  _req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const data = await getAdminMonitorBookings();
    return res.status(200).json(data);
  } catch (error) {
    logAdminEndpointError("monitor/bookings", error);
    return handleControllerError(res, error, "Failed to load admin booking monitoring");
  }
};

export const getAdminMonitorPrescriptionsController = async (
  _req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const data = await getAdminMonitorPrescriptions();
    return res.status(200).json(data);
  } catch (error) {
    logAdminEndpointError("monitor/prescriptions", error);
    return handleControllerError(res, error, "Failed to load admin prescription monitoring");
  }
};
