import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  createCenterSchedule,
  getCenterDoctorAvailabilityState,
  disableCenterSchedule,
  getCenterDoctorAvailabilityForDate,
  listCenterSchedules,
  listCenterDoctorRoutines,
  listCenterSchedulesForDoctor,
  previewCenterSchedule,
  saveCenterDoctorRoutine,
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

type RoutineBody = {
  weeks?: number | string;
  slotDuration?: number | string;
  maxPatients?: number | string;
  routine?: Array<{
    dayOfWeek?: number | string;
    shifts?: Array<{ start?: string; end?: string; roomNumber?: string | null }>;
  }>;
};

type CenterRequest<TBody = Record<string, unknown>> = AuthenticatedRequest<TBody> & {
  medicalCenterId: string;
  params: Record<string, string>;
};

type HttpError = Error & { statusCode?: number; details?: string[] };

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
    ...(Array.isArray(appError?.details) && appError.details.length > 0
      ? { details: appError.details }
      : {}),
  });
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

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to disable schedule");
  }
};

export const listMedicalCenterDoctorSchedulesController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as CenterRequest;

  try {
    const activeOnly = String(req.query.active_only || "").trim().toLowerCase() === "true";
    const doctorUserId = Number(typedReq.params.doctorId || "");
    const schedules = await listCenterSchedulesForDoctor(typedReq.medicalCenterId, doctorUserId, {
      activeOnly,
    });
    return res.status(200).json(schedules);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load doctor schedules");
  }
};

export const listMedicalCenterDoctorRoutinesController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as CenterRequest;

  try {
    const doctorUserId = Number(typedReq.params.doctorId || "");
    const routines = await listCenterDoctorRoutines(typedReq.medicalCenterId, doctorUserId);
    return res.status(200).json(routines);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load doctor routines");
  }
};

export const getMedicalCenterDoctorAvailabilityController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as CenterRequest;

  try {
    const doctorUserId = Number(typedReq.params.doctorId || "");
    const date = String(req.query.date || "");
    const availability = await getCenterDoctorAvailabilityForDate(
      typedReq.medicalCenterId,
      doctorUserId,
      date
    );
    return res.status(200).json(availability);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load doctor availability");
  }
};

export const getMedicalCenterDoctorAvailabilityStateController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as CenterRequest;

  try {
    const doctorUserId = Number(typedReq.params.doctorId || "");
    const availability = await getCenterDoctorAvailabilityState(
      typedReq.medicalCenterId,
      doctorUserId
    );
    return res.status(200).json(availability);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load weekly doctor availability");
  }
};

export const saveMedicalCenterDoctorRoutineController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as CenterRequest<RoutineBody>;

  try {
    const doctorUserId = Number(typedReq.params.doctorId || "");
    const result = await saveCenterDoctorRoutine({
      medicalCenterId: typedReq.medicalCenterId,
      doctorUserId,
      weeks:
        typedReq.body?.weeks === undefined ? undefined : Number(typedReq.body.weeks),
      slotDuration: Number(typedReq.body?.slotDuration),
      maxPatients: Number(typedReq.body?.maxPatients),
      routine: Array.isArray(typedReq.body?.routine)
        ? typedReq.body.routine.map((day) => ({
            dayOfWeek: Number(day?.dayOfWeek),
            shifts: Array.isArray(day?.shifts)
              ? day.shifts.map((shift) => ({
                  start: String(shift?.start || ""),
                  end: String(shift?.end || ""),
                  roomNumber:
                    typeof shift?.roomNumber === "string" && shift.roomNumber.trim()
                      ? shift.roomNumber.trim()
                      : null,
                }))
              : [],
          }))
        : [],
    });

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to save routine schedule");
  }
};

export const createMedicalCenterDoctorManualScheduleController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as CenterRequest<ScheduleBody>;

  try {
    const doctorUserId = Number(typedReq.params.doctorId || "");
    const result = await createCenterSchedule({
      medicalCenterId: typedReq.medicalCenterId,
      doctorUserId,
      date: String(typedReq.body?.date || ""),
      startTime: String(typedReq.body?.start_time || ""),
      endTime: String(typedReq.body?.end_time || ""),
      slotDuration: Number(typedReq.body?.slot_duration),
      maxPatients: Number(typedReq.body?.max_patients),
      createdByUserId: Number(typedReq.user?.id),
    });

    return res.status(201).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to create manual schedule");
  }
};

export const disableMedicalCenterDoctorScheduleController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as CenterRequest;

  try {
    const doctorUserId = Number(typedReq.params.doctorId || "");
    const result = await disableCenterSchedule({
      medicalCenterId: typedReq.medicalCenterId,
      scheduleId: String(typedReq.params.scheduleId || ""),
      doctorUserId,
      disabledByUserId: Number(typedReq.user?.id),
    });

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to disable doctor schedule");
  }
};
