import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  createDoctorAvailability,
  deleteDoctorAvailability,
  getDoctorDailyReportData,
  getDoctorDashboardData,
  getDoctorQueueDashboardData,
  listDoctorAvailability,
  listDoctorWorkingDays,
  replaceDoctorWorkingDays,
  updateDoctorAvailability,
} from "../services/doctor.service";

type AvailabilityBody = {
  day?: string;
  start_time?: string;
  end_time?: string;
  max_patients?: number | null;
};

type WorkingDaysBody = {
  days?: string[];
};

type HttpError = Error & { statusCode?: number };

const getDoctorUserId = (req: AuthenticatedRequest) => {
  if (!req.user?.id) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  if (req.user.role !== "doctor") {
    throw Object.assign(new Error("Only doctors can access this resource"), {
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

export const createAvailability = async (
  req: AuthenticatedRequest<AvailabilityBody>,
  res: Response
) => {
  try {
    const userId = getDoctorUserId(req);
    const { day, start_time, end_time, max_patients } = req.body || {};

    if (!day || !start_time || !end_time) {
      return res.status(400).json({ message: "day, start_time, end_time are required" });
    }

    const availability = await createDoctorAvailability(userId, {
      day,
      startTime: start_time,
      endTime: end_time,
      maxPatients: max_patients ?? null,
    });

    return res.json({ message: "Availability saved", availability });
  } catch (error) {
    console.error("Availability save error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const getAvailability = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getDoctorUserId(req);
    const availability = await listDoctorAvailability(userId);
    return res.json(availability);
  } catch (error) {
    console.error("Availability fetch error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const saveWorkingDays = async (
  req: AuthenticatedRequest<WorkingDaysBody>,
  res: Response
) => {
  try {
    const userId = getDoctorUserId(req);
    const { days } = req.body || {};

    if (!Array.isArray(days)) {
      return res.status(400).json({ message: "days must be an array" });
    }

    const savedDays = await replaceDoctorWorkingDays(userId, days);
    return res.json({ message: "Working days saved", days: savedDays });
  } catch (error) {
    console.error("Working days save error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const getWorkingDays = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getDoctorUserId(req);
    const days = await listDoctorWorkingDays(userId);
    return res.json(days);
  } catch (error) {
    console.error("Working days fetch error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const removeAvailability = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getDoctorUserId(req);
    const { id } = req.params;

    await deleteDoctorAvailability(userId, id);
    return res.json({ message: "Shift deleted" });
  } catch (error) {
    console.error("Availability delete error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const editAvailability = async (
  req: AuthenticatedRequest<AvailabilityBody>,
  res: Response
) => {
  try {
    const userId = getDoctorUserId(req);
    const { id } = req.params;
    const { day, start_time, end_time, max_patients } = req.body || {};

    if (!day || !start_time || !end_time) {
      return res.status(400).json({ message: "day, start_time, end_time are required" });
    }

    const availability = await updateDoctorAvailability(userId, id, {
      day,
      startTime: start_time,
      endTime: end_time,
      maxPatients: max_patients ?? null,
    });

    return res.json(availability);
  } catch (error) {
    console.error("Availability update error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const getDashboard = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getDoctorUserId(req);
    const data = await getDoctorDashboardData(userId);
    return res.json(data);
  } catch (error) {
    console.error("Doctor dashboard error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const getQueueDashboard = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getDoctorUserId(req);
    const scheduleId =
      typeof req.query.scheduleId === "string"
        ? req.query.scheduleId
        : typeof req.query.sessionId === "string"
          ? req.query.sessionId
          : undefined;
    const data = await getDoctorQueueDashboardData(userId, { scheduleId });
    return res.json(data);
  } catch (error) {
    console.error("Dashboard error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const getDailyReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = getDoctorUserId(req);
    const dateQuery = typeof req.query.date === "string" ? req.query.date : undefined;
    const data = await getDoctorDailyReportData(userId, dateQuery);
    return res.json(data);
  } catch (error) {
    console.error("Daily report error:", error);
    return handleControllerError(res, error, "Server error");
  }
};
