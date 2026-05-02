import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  createDoctorAvailabilitySlot,
  getDoctorAvailabilityState,
  replaceDoctorAvailabilityState,
  type AvailabilityEnabledDaysInput,
  type AvailabilityStateInput,
} from "../services/availability.service";

type HttpError = Error & { statusCode?: number };

type AvailabilityBody = {
  day_of_week?: number;
  start_time?: string;
  end_time?: string;
  availability?: AvailabilityStateInput;
  enabled_days?: AvailabilityEnabledDaysInput;
};

const getDoctorUserId = (req: AuthenticatedRequest) => {
  if (!req.user?.id) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  if (String(req.user.role || "").toLowerCase() !== "doctor") {
    throw Object.assign(new Error("Only doctors can access this resource"), { statusCode: 403 });
  }

  return Number(req.user.id);
};

const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
};

export const getDoctorAvailabilityController: RequestHandler = async (req, res) => {
  try {
    const doctorUserId = getDoctorUserId(req as AuthenticatedRequest);
    const availability = await getDoctorAvailabilityState(doctorUserId);
    return res.status(200).json(availability);
  } catch (error) {
    return handleError(res, error, "Failed to load availability");
  }
};

export const createDoctorAvailabilityController: RequestHandler = async (req, res) => {
  try {
    const doctorUserId = getDoctorUserId(req as AuthenticatedRequest<AvailabilityBody>);
    const body = (req as AuthenticatedRequest<AvailabilityBody>).body || {};
    const availability = await createDoctorAvailabilitySlot(doctorUserId, {
      dayOfWeek: Number(body.day_of_week),
      startTime: String(body.start_time || ""),
      endTime: String(body.end_time || ""),
    });
    return res.status(201).json(availability);
  } catch (error) {
    return handleError(res, error, "Failed to create availability");
  }
};

export const replaceDoctorAvailabilityController: RequestHandler = async (req, res) => {
  try {
    const doctorUserId = getDoctorUserId(req as AuthenticatedRequest<AvailabilityBody>);
    const body = (req as AuthenticatedRequest<AvailabilityBody>).body || {};
    const availability = await replaceDoctorAvailabilityState(
      doctorUserId,
      body.availability || {},
      Array.isArray(body.enabled_days) ? body.enabled_days : []
    );
    return res.status(200).json(availability);
  } catch (error) {
    return handleError(res, error, "Failed to update availability");
  }
};
