import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { io } from "../server";
import {
  createCenterSchedule,
  disableCenterSchedule,
  listCenterSchedules,
  previewCenterSchedule,
  updateCenterSchedule,
} from "../services/schedule.service";

type ScheduleBody = {
  doctor_id?: number | string;
  date?: string;
  start_time?: string;
  end_time?: string;
  slot_duration?: number | string;
  max_patients?: number | string;
  is_active?: boolean;
};

type CenterRequest<TBody = Record<string, unknown>> = AuthenticatedRequest<TBody> & {
  medicalCenterId: string;
  params: Record<string, string>;
};

type HttpError = Error & { statusCode?: number };

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
};

const emitScheduleUpdate = (doctorId: number | string, medicalCenterId: string, payload?: Record<string, unknown>) => {
  const data = { doctorId, medicalCenterId, ...(payload || {}) };
  io.to(`doctor_${doctorId}`).emit("schedule:update", data);
  io.to(`doctor-${doctorId}`).emit("schedule:update", data);
  io.to(`center_${medicalCenterId}`).emit("schedule:update", data);
};

export const listMedicalCenterSchedulesController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as CenterRequest;

  try {
    const activeOnly = String(req.query.active_only || "").trim().toLowerCase() === "true";
    const schedules = await listCenterSchedules(typedReq.medicalCenterId, { activeOnly });
    return res.status(200).json(schedules);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load schedules");
  }
};

export const previewMedicalCenterScheduleController: RequestHandler = async (
  req,
  res: Response
) => {
    const typedReq = req as CenterRequest<ScheduleBody>;

    try {
      const preview = await previewCenterSchedule({
        medicalCenterId: typedReq.medicalCenterId,
        doctorUserId: Number(typedReq.body?.doctor_id),
        date: String(typedReq.body?.date || ""),
        startTime: String(typedReq.body?.start_time || ""),
        endTime: String(typedReq.body?.end_time || ""),
        slotDuration: Number(typedReq.body?.slot_duration),
        maxPatients: Number(typedReq.body?.max_patients),
      });

      return res.status(200).json(preview);
    } catch (error) {
      return handleControllerError(res, error, "Failed to preview schedule");
    }
};

export const createMedicalCenterScheduleController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as CenterRequest<ScheduleBody>;

  try {
    const result = await createCenterSchedule({
      medicalCenterId: typedReq.medicalCenterId,
      doctorUserId: Number(typedReq.body?.doctor_id),
      date: String(typedReq.body?.date || ""),
      startTime: String(typedReq.body?.start_time || ""),
      endTime: String(typedReq.body?.end_time || ""),
      slotDuration: Number(typedReq.body?.slot_duration),
      maxPatients: Number(typedReq.body?.max_patients),
      createdByUserId: Number(typedReq.user?.id),
    });

    emitScheduleUpdate(result.schedule.doctor_id, typedReq.medicalCenterId, {
      type: "session:created",
      scheduleId: result.schedule.id,
    });

    return res.status(201).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to create schedule");
  }
};

export const updateMedicalCenterScheduleController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as CenterRequest<ScheduleBody>;

  try {
    const result = await updateCenterSchedule({
      medicalCenterId: typedReq.medicalCenterId,
      scheduleId: String(typedReq.params.id || ""),
      doctorUserId:
        typedReq.body?.doctor_id === undefined ? undefined : Number(typedReq.body?.doctor_id),
      date: typedReq.body?.date,
      startTime: typedReq.body?.start_time,
      endTime: typedReq.body?.end_time,
      slotDuration:
        typedReq.body?.slot_duration === undefined
          ? undefined
          : Number(typedReq.body?.slot_duration),
      maxPatients:
        typedReq.body?.max_patients === undefined ? undefined : Number(typedReq.body?.max_patients),
      isActive: typeof typedReq.body?.is_active === "boolean" ? typedReq.body.is_active : undefined,
      updatedByUserId: Number(typedReq.user?.id),
    });

    emitScheduleUpdate(result.schedule.doctor_id, typedReq.medicalCenterId, {
      type: "session:updated",
      scheduleId: result.schedule.id,
    });

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to update schedule");
  }
};

export const disableMedicalCenterScheduleController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as CenterRequest;

  try {
    const result = await disableCenterSchedule({
      medicalCenterId: typedReq.medicalCenterId,
      scheduleId: String(typedReq.params.id || ""),
      disabledByUserId: Number(typedReq.user?.id),
    });

    emitScheduleUpdate(result.schedule.doctor_id, typedReq.medicalCenterId, {
      type: "session:disabled",
      scheduleId: result.schedule.id,
    });

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to disable schedule");
  }
};
