import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import pool from "../config/db";
import { listMedicalCenterDoctorsWithInvites } from "../services/doctorAssociation.service";
import {
  createCenterSchedule,
  disableCenterSchedule,
  getCenterDoctorAvailabilityForDate,
  getCenterDoctorAvailabilityState,
  listCenterDoctorRoutines,
  listCenterSchedulesForDoctor,
  saveCenterDoctorRoutine,
  updateCenterSchedule,
} from "../services/schedule.service";
import {
  cancelReceptionVisit,
  checkInReceptionVisit,
  completeReceptionQueuePatient,
  completeReceptionVisit,
  createReceptionAppointment,
  addReceptionWalkInToQueue,
  getReceptionDashboardData,
  getReceptionAppointmentsData,
  getReceptionVisitDetailData,
  getReceptionVisitsData,
  listReceptionPatientsData,
  getReceptionQueueDetailData,
  getReceptionQueueData,
  getReceptionPermissionsData,
  endReceptionQueue,
  markReceptionVisitMissed,
  pauseReceptionQueue,
  registerReceptionPatientData,
  resumeReceptionQueue,
  missReceptionQueuePatient,
  moveReceptionQueueToNextPatient,
  sendReceptionVisitToQueue,
  startReceptionQueue,
  updateReceptionAppointmentStatus,
} from "../services/receptionQueue.service";

type HttpError = Error & { statusCode?: number; details?: string[]; code?: string };

type QueueActionBody = {
  sessionId?: number | string | null;
  queueId?: number | string | null;
};

type AppointmentCheckInBody = {
  appointmentId?: number | string | null;
  id?: number | string | null;
};

type QueueWalkInBody = QueueActionBody & {
  name?: string | null;
  phone?: string | null;
  priority?: string | null;
};

type AppointmentCreateBody = {
  sessionId?: number | string | null;
  time?: string | null;
  patientId?: number | string | null;
  patientName?: string | null;
  phone?: string | null;
};

type AppointmentUpdateBody = {
  status?: string | null;
};

type VisitCreateBody = AppointmentCreateBody;

type ReceptionRoutineBody = {
  weeks?: number | string;
  slotDuration?: number | string;
  maxPatients?: number | string;
  routine?: Array<{
    dayOfWeek?: number | string;
    shifts?: Array<{ start?: string; end?: string; roomNumber?: string | null }>;
  }>;
};

type RegisterPatientBody = {
  name?: string | null;
  phone?: string | null;
  sessionId?: number | string | null;
  addToQueue?: boolean | null;
};

type ReceptionDoctorAvailabilitySummaryRow = {
  doctor_profile_id: number;
  day_of_week: number | null;
  day: string | null;
  start_time: string;
  end_time: string;
};

type ReceptionDoctorScheduleCountRow = {
  doctor_user_id: number;
  today_session_count: number;
  upcoming_session_count: number;
};

const AVAILABILITY_DAY_KEYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;

const requireReceptionContext = (req: AuthenticatedRequest) => {
  if (req.user?.role !== "receptionist" && req.user?.role !== "medical_center_admin") {
    throw Object.assign(new Error("Only reception users can access this resource"), {
      statusCode: 403,
    });
  }

  if (!req.user?.id || !req.user?.medicalCenterId) {
    throw Object.assign(new Error("Medical center context missing"), { statusCode: 403 });
  }

  return {
    userId: req.user.id,
    medicalCenterId: req.user.medicalCenterId,
  };
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  return res.status(Number(appError?.statusCode) || 500).json({
    success: false,
    message: appError?.message || fallbackMessage,
    ...(typeof appError?.code === "string" && appError.code.trim() ? { code: appError.code } : {}),
    ...(Array.isArray(appError?.details) && appError.details.length > 0
      ? { details: appError.details }
      : {}),
  });
};

const buildAvailabilitySummaryByDoctor = async (doctorProfileIds: number[]) => {
  if (doctorProfileIds.length === 0) {
    return new Map<number, string[]>();
  }

  const result = await pool.query<ReceptionDoctorAvailabilitySummaryRow>(
    `
      SELECT
        da.doctor_id AS doctor_profile_id,
        da.day_of_week,
        da.day,
        da.start_time::text AS start_time,
        da.end_time::text AS end_time
      FROM doctor_availability da
      WHERE da.doctor_id = ANY($1::int[])
        AND COALESCE(da.is_active, TRUE) = TRUE
      ORDER BY da.doctor_id ASC, COALESCE(da.day_of_week, 7) ASC, da.start_time ASC
    `,
    [doctorProfileIds]
  );

  const perDoctorDayRanges = new Map<number, Map<number, { firstStart: string; lastEnd: string }>>();

  result.rows.forEach((row) => {
    const dayOfWeek =
      typeof row.day_of_week === "number"
        ? row.day_of_week
        : ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(
            String(row.day || "").trim().toLowerCase()
          );

    if (dayOfWeek < 0 || dayOfWeek > 6) {
      return;
    }

    if (!perDoctorDayRanges.has(row.doctor_profile_id)) {
      perDoctorDayRanges.set(row.doctor_profile_id, new Map());
    }

    const doctorRanges = perDoctorDayRanges.get(row.doctor_profile_id)!;
    const existing = doctorRanges.get(dayOfWeek);
    const startTime = String(row.start_time || "").slice(0, 5);
    const endTime = String(row.end_time || "").slice(0, 5);

    if (!existing) {
      doctorRanges.set(dayOfWeek, {
        firstStart: startTime,
        lastEnd: endTime,
      });
      return;
    }

    if (startTime < existing.firstStart) {
      existing.firstStart = startTime;
    }

    if (endTime > existing.lastEnd) {
      existing.lastEnd = endTime;
    }
  });

  const summaryByDoctor = new Map<number, string[]>();

  perDoctorDayRanges.forEach((dayRanges, doctorProfileId) => {
    const summary = Array.from(dayRanges.entries())
      .sort((left, right) => left[0] - right[0])
      .slice(0, 3)
      .map(([dayOfWeek, range]) => {
        const dayLabel = AVAILABILITY_DAY_KEYS[dayOfWeek] || "day";
        return `${dayLabel.toUpperCase()} ${range.firstStart}-${range.lastEnd}`;
      });

    summaryByDoctor.set(doctorProfileId, summary);
  });

  return summaryByDoctor;
};

const buildSessionCountsByDoctor = async (medicalCenterId: string, doctorUserIds: number[], today: string) => {
  if (doctorUserIds.length === 0) {
    return new Map<number, { todaySessionCount: number; upcomingSessionCount: number }>();
  }

  const result = await pool.query<ReceptionDoctorScheduleCountRow>(
    `
      SELECT
        s.doctor_user_id,
        COUNT(*) FILTER (WHERE s.date = $2::date)::int AS today_session_count,
        COUNT(*) FILTER (WHERE s.date >= $2::date)::int AS upcoming_session_count
      FROM medical_center_doctor_schedule s
      WHERE s.medical_center_id = $1
        AND s.doctor_user_id = ANY($3::int[])
        AND COALESCE(s.is_active, TRUE) = TRUE
      GROUP BY s.doctor_user_id
    `,
    [medicalCenterId, today, doctorUserIds]
  );

  return new Map<number, { todaySessionCount: number; upcomingSessionCount: number }>(
    result.rows.map((row) => [
      Number(row.doctor_user_id),
      {
        todaySessionCount: Number(row.today_session_count || 0),
        upcomingSessionCount: Number(row.upcoming_session_count || 0),
      },
    ])
  );
};

export const getReceptionPermissions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId, medicalCenterId } = requireReceptionContext(req);
    return res.json(await getReceptionPermissionsData(userId, medicalCenterId));
  } catch (error) {
    console.error("Reception permissions error:", error);
    return handleControllerError(res, error, "Failed to load permissions");
  }
};

export const getReceptionDashboard = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(await getReceptionDashboardData(medicalCenterId));
  } catch (error) {
    console.error("Reception dashboard error:", error);
    return handleControllerError(res, error, "Failed to load dashboard");
  }
};

export const getReceptionQueue = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(await getReceptionQueueData(medicalCenterId));
  } catch (error) {
    console.error("Reception queue error:", error);
    return handleControllerError(res, error, "Failed to load queue");
  }
};

export const getReceptionQueueDetail = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    const queueId =
      typeof req.params.queueId === "string"
        ? Number(req.params.queueId)
        : typeof req.query.queueId === "string"
          ? Number(req.query.queueId)
          : undefined;
    const sessionId =
      typeof req.params.sessionId === "string"
        ? Number(req.params.sessionId)
        : typeof req.query.sessionId === "string"
          ? Number(req.query.sessionId)
          : undefined;

    return res.json(
      await getReceptionQueueDetailData({
        medicalCenterId,
        queueId,
        sessionId,
      })
    );
  } catch (error) {
    console.error("Reception queue detail error:", error);
    return handleControllerError(res, error, "Failed to load queue details");
  }
};

export const getReceptionAppointments = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(
      await getReceptionAppointmentsData(medicalCenterId, {
        date: typeof req.query.date === "string" ? req.query.date : null,
        status: typeof req.query.status === "string" ? req.query.status : null,
      })
    );
  } catch (error) {
    console.error("Reception appointments error:", error);
    return handleControllerError(res, error, "Failed to load appointments");
  }
};

export const getReceptionVisits = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(
      await getReceptionVisitsData(medicalCenterId, {
        filter: typeof req.query.filter === "string" ? req.query.filter : null,
        date: typeof req.query.date === "string" ? req.query.date : null,
        search: typeof req.query.search === "string" ? req.query.search : null,
        doctorId: typeof req.query.doctorId === "string" ? Number(req.query.doctorId) : null,
        sessionId: typeof req.query.sessionId === "string" ? Number(req.query.sessionId) : null,
        page: typeof req.query.page === "string" ? Number(req.query.page) : null,
        limit: typeof req.query.limit === "string" ? Number(req.query.limit) : null,
      })
    );
  } catch (error) {
    console.error("Reception visits error:", error);
    return handleControllerError(res, error, "Failed to load visits");
  }
};

export const getReceptionVisitDetail = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(await getReceptionVisitDetailData(medicalCenterId, Number(req.params.id)));
  } catch (error) {
    console.error("Reception visit detail error:", error);
    return handleControllerError(res, error, "Failed to load visit details");
  }
};

export const createReceptionAppointmentController = async (
  req: AuthenticatedRequest<AppointmentCreateBody>,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.status(201).json(
      await createReceptionAppointment({
        medicalCenterId,
        sessionId: Number(req.body?.sessionId),
        time: String(req.body?.time || ""),
        patientId: req.body?.patientId ? Number(req.body.patientId) : null,
        patientName: req.body?.patientName ?? null,
        phone: req.body?.phone ?? null,
      })
    );
  } catch (error) {
    console.error("Reception create appointment error:", error);
    return handleControllerError(res, error, "Failed to create appointment");
  }
};

export const createReceptionVisitController = async (
  req: AuthenticatedRequest<VisitCreateBody>,
  res: Response
) => createReceptionAppointmentController(req, res);

export const updateReceptionAppointmentController = async (
  req: AuthenticatedRequest<AppointmentUpdateBody>,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(
      await updateReceptionAppointmentStatus({
        medicalCenterId,
        appointmentId: Number(req.params.appointmentId),
        status: String(req.body?.status || ""),
      })
    );
  } catch (error) {
    console.error("Reception update appointment error:", error);
    return handleControllerError(res, error, "Failed to update appointment");
  }
};

export const checkInReceptionVisitController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(await checkInReceptionVisit(medicalCenterId, Number(req.params.id)));
  } catch (error) {
    console.error("Reception visit check-in error:", error);
    return handleControllerError(res, error, "Failed to check in patient");
  }
};

export const checkInReceptionAppointmentController = async (
  req: AuthenticatedRequest<AppointmentCheckInBody>,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    const appointmentId = Number(req.body?.appointmentId ?? req.body?.id);
    return res.json(await checkInReceptionVisit(medicalCenterId, appointmentId));
  } catch (error) {
    console.error("Reception appointment check-in error:", error);
    return handleControllerError(res, error, "Failed to check in patient");
  }
};

export const markReceptionVisitMissedController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(await markReceptionVisitMissed(medicalCenterId, Number(req.params.id)));
  } catch (error) {
    console.error("Reception visit missed error:", error);
    return handleControllerError(res, error, "Failed to mark visit missed");
  }
};

export const cancelReceptionVisitController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(await cancelReceptionVisit(medicalCenterId, Number(req.params.id)));
  } catch (error) {
    console.error("Reception visit cancel error:", error);
    return handleControllerError(res, error, "Failed to cancel visit");
  }
};

export const sendReceptionVisitToQueueController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(await sendReceptionVisitToQueue(medicalCenterId, Number(req.params.id)));
  } catch (error) {
    console.error("Reception visit send-to-queue error:", error);
    return handleControllerError(res, error, "Failed to send patient to queue");
  }
};

export const completeReceptionVisitController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(await completeReceptionVisit(medicalCenterId, Number(req.params.id)));
  } catch (error) {
    console.error("Reception visit complete error:", error);
    return handleControllerError(res, error, "Failed to complete visit");
  }
};

export const listReceptionPatients = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(await listReceptionPatientsData(medicalCenterId));
  } catch (error) {
    console.error("Reception patients error:", error);
    return handleControllerError(res, error, "Failed to load patients");
  }
};

export const registerReceptionPatient = async (
  req: AuthenticatedRequest<RegisterPatientBody>,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.status(201).json(
      await registerReceptionPatientData({
        medicalCenterId,
        name: String(req.body?.name || ""),
        phone: req.body?.phone ?? null,
        sessionId: req.body?.sessionId ? Number(req.body.sessionId) : null,
        addToQueue: Boolean(req.body?.addToQueue),
      })
    );
  } catch (error) {
    console.error("Reception register patient error:", error);
    return handleControllerError(res, error, "Failed to register patient");
  }
};

export const queueWalkIn = async (
  req: AuthenticatedRequest<QueueWalkInBody>,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.status(201).json(
      await addReceptionWalkInToQueue({
        medicalCenterId,
        name: String(req.body?.name || ""),
        phone: req.body?.phone ?? null,
        priority: req.body?.priority ?? "normal",
        sessionId: req.body?.sessionId ? Number(req.body.sessionId) : null,
        queueId: req.body?.queueId ? Number(req.body.queueId) : req.params.queueId ? Number(req.params.queueId) : null,
      })
    );
  } catch (error) {
    console.error("Reception queue walk-in error:", error);
    return handleControllerError(res, error, "Failed to add walk-in patient");
  }
};

export const queueNextPatient = async (
  req: AuthenticatedRequest<QueueActionBody>,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    const sessionId = Number(req.body?.sessionId);
    const queueId =
      req.body?.queueId ? Number(req.body.queueId) : req.params.queueId ? Number(req.params.queueId) : null;
    return res.json(await moveReceptionQueueToNextPatient(medicalCenterId, sessionId, queueId));
  } catch (error) {
    console.error("Reception queue next error:", error);
    return handleControllerError(res, error, "Failed to advance queue");
  }
};

export const queueCompletePatient = async (
  req: AuthenticatedRequest<QueueActionBody>,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    const sessionId = Number(req.body?.sessionId);
    const queueId =
      req.body?.queueId ? Number(req.body.queueId) : req.params.queueId ? Number(req.params.queueId) : null;
    return res.json(await completeReceptionQueuePatient(medicalCenterId, sessionId, queueId));
  } catch (error) {
    console.error("Reception queue complete error:", error);
    return handleControllerError(res, error, "Failed to complete patient");
  }
};

export const queueMissPatient = async (
  req: AuthenticatedRequest<QueueActionBody>,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    const sessionId = Number(req.body?.sessionId);
    const queueId =
      req.body?.queueId ? Number(req.body.queueId) : req.params.queueId ? Number(req.params.queueId) : null;
    return res.json(await missReceptionQueuePatient(medicalCenterId, sessionId, queueId));
  } catch (error) {
    console.error("Reception queue miss error:", error);
    return handleControllerError(res, error, "Failed to mark patient missed");
  }
};

export const queueStart = async (req: AuthenticatedRequest<QueueActionBody>, res: Response) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    const sessionId = Number(req.body?.sessionId);
    return res.json(await startReceptionQueue({ medicalCenterId, sessionId }));
  } catch (error) {
    console.error("Reception queue start error:", error);
    return handleControllerError(res, error, "Failed to start queue");
  }
};

export const queuePause = async (req: AuthenticatedRequest<QueueActionBody>, res: Response) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(
      await pauseReceptionQueue({
        medicalCenterId,
        sessionId: req.body?.sessionId ? Number(req.body.sessionId) : null,
        queueId:
          req.body?.queueId ? Number(req.body.queueId) : req.params.queueId ? Number(req.params.queueId) : null,
      })
    );
  } catch (error) {
    console.error("Reception queue pause error:", error);
    return handleControllerError(res, error, "Failed to pause queue");
  }
};

export const queueResume = async (req: AuthenticatedRequest<QueueActionBody>, res: Response) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(
      await resumeReceptionQueue({
        medicalCenterId,
        sessionId: req.body?.sessionId ? Number(req.body.sessionId) : null,
        queueId:
          req.body?.queueId ? Number(req.body.queueId) : req.params.queueId ? Number(req.params.queueId) : null,
      })
    );
  } catch (error) {
    console.error("Reception queue resume error:", error);
    return handleControllerError(res, error, "Failed to resume queue");
  }
};

export const queueEnd = async (req: AuthenticatedRequest<QueueActionBody>, res: Response) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(
      await endReceptionQueue({
        medicalCenterId,
        sessionId: req.body?.sessionId ? Number(req.body.sessionId) : null,
        queueId:
          req.body?.queueId ? Number(req.body.queueId) : req.params.queueId ? Number(req.params.queueId) : null,
      })
    );
  } catch (error) {
    console.error("Reception queue end error:", error);
    return handleControllerError(res, error, "Failed to end queue");
  }
};

export const getReceptionSessionDoctors = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    const today = new Date().toISOString().slice(0, 10);
    const rows = await listMedicalCenterDoctorsWithInvites(medicalCenterId);
    const doctors = rows.filter(
      (row) =>
        row &&
        row.status === "ACTIVE" &&
        row.is_hidden !== true &&
        typeof row.doctor_id === "number" &&
        typeof row.doctor_profile_id === "number"
    );

    const [availabilitySummaryByDoctor, sessionCountsByDoctor] = await Promise.all([
      buildAvailabilitySummaryByDoctor(
        doctors.map((doctor) => doctor.doctor_profile_id as number)
      ),
      buildSessionCountsByDoctor(
        medicalCenterId,
        doctors.map((doctor) => doctor.doctor_id as number),
        today
      ),
    ]);

    const payload = doctors.map((doctor) => {
      const availabilitySummary =
        availabilitySummaryByDoctor.get(doctor.doctor_profile_id as number) || [];
      const counts = sessionCountsByDoctor.get(doctor.doctor_id as number);

      return {
        relationshipId: doctor.id,
        doctorId: doctor.doctor_profile_id,
        doctorUserId: doctor.doctor_id,
        doctorName: doctor.name || "Doctor",
        doctorProfileImage: doctor.profile_image || null,
        email: doctor.email,
        specialization: doctor.clinic_specialty || doctor.specialization || null,
        clinicSpecialty: doctor.clinic_specialty || null,
        medicalCenterId,
        availabilitySummary,
        todaySessionCount: counts?.todaySessionCount || 0,
        upcomingSessionCount: counts?.upcomingSessionCount || 0,
        status: doctor.status,
      };
    });

    return res.json(payload);
  } catch (error) {
    console.error("Reception session doctors error:", error);
    return handleControllerError(res, error, "Failed to load doctors for session management");
  }
};

export const getReceptionSessionDoctorAvailabilityState = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(
      await getCenterDoctorAvailabilityState(medicalCenterId, Number(req.params.doctorId))
    );
  } catch (error) {
    console.error("Reception availability state error:", error);
    return handleControllerError(res, error, "Failed to load weekly doctor availability");
  }
};

export const getReceptionSessionDoctorAvailability = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(
      await getCenterDoctorAvailabilityForDate(
        medicalCenterId,
        Number(req.params.doctorId),
        String(req.query.date || "")
      )
    );
  } catch (error) {
    console.error("Reception doctor availability error:", error);
    return handleControllerError(res, error, "Failed to load doctor availability");
  }
};

export const getReceptionSessionDoctorSchedules = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    const activeOnly = String(req.query.active_only || "").trim().toLowerCase() === "true";
    const schedules = await listCenterSchedulesForDoctor(medicalCenterId, Number(req.params.doctorId), {
        activeOnly,
      });
    const scheduleIds = schedules.map((item) => item.id).filter((id) => Number.isInteger(id));

    const bookingCounts =
      scheduleIds.length > 0
        ? await pool.query<{
            session_id: number;
            booked_count: number;
          }>(
            `
              SELECT
                b.session_id,
                COUNT(*)::int AS booked_count
              FROM bookings b
              WHERE b.session_id = ANY($1::int[])
                AND UPPER(COALESCE(b.status, 'BOOKED')) NOT IN ('CANCELLED', 'MISSED')
              GROUP BY b.session_id
            `,
            [scheduleIds]
          )
        : { rows: [] };
    const countsBySession = new Map<number, number>(
      bookingCounts.rows.map(
        (row): [number, number] => [Number(row.session_id), Number(row.booked_count) || 0]
      )
    );

    return res.json(
      schedules.map((item) => {
        const bookedCount = countsBySession.get(item.id) ?? 0;
        return {
          ...item,
          booked_count: bookedCount,
          available_count: Math.max(0, Number(item.max_patients || 0) - bookedCount),
        };
      })
    );
  } catch (error) {
    console.error("Reception doctor schedules error:", error);
    return handleControllerError(res, error, "Failed to load doctor schedules");
  }
};

export const getReceptionSessionDoctorRoutines = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    return res.json(
      await listCenterDoctorRoutines(medicalCenterId, Number(req.params.doctorId))
    );
  } catch (error) {
    console.error("Reception doctor routines error:", error);
    return handleControllerError(res, error, "Failed to load doctor routines");
  }
};

export const saveReceptionSessionDoctorRoutine = async (
  req: AuthenticatedRequest<ReceptionRoutineBody>,
  res: Response
) => {
  try {
    const { medicalCenterId } = requireReceptionContext(req);
    const doctorUserId = Number(req.params.doctorId);
    const result = await saveCenterDoctorRoutine({
      medicalCenterId,
      doctorUserId,
      weeks: req.body?.weeks === undefined ? undefined : Number(req.body.weeks),
      slotDuration: Number(req.body?.slotDuration),
      maxPatients: Number(req.body?.maxPatients),
      routine: Array.isArray(req.body?.routine)
        ? req.body.routine.map((day) => ({
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
    return res.json(result);
  } catch (error) {
    console.error("Reception save routine error:", error);
    return handleControllerError(res, error, "Failed to save routine schedule");
  }
};

export const createReceptionSessionDoctorManualSchedule = async (
  req: AuthenticatedRequest<{
    date?: string;
    start_time?: string;
    end_time?: string;
    slot_duration?: number | string;
    max_patients?: number | string;
  }>,
  res: Response
) => {
  try {
    const { medicalCenterId, userId } = requireReceptionContext(req);
    const result = await createCenterSchedule({
      medicalCenterId,
      doctorUserId: Number(req.params.doctorId),
      date: String(req.body?.date || ""),
      startTime: String(req.body?.start_time || ""),
      endTime: String(req.body?.end_time || ""),
      slotDuration: Number(req.body?.slot_duration),
      maxPatients: Number(req.body?.max_patients),
      createdByUserId: userId,
    });
    return res.status(201).json(result);
  } catch (error) {
    console.error("Reception create manual session error:", error);
    return handleControllerError(res, error, "Failed to create manual session");
  }
};

export const deleteReceptionSessionSchedule = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { medicalCenterId, userId } = requireReceptionContext(req);
    return res.json(
      await disableCenterSchedule({
        medicalCenterId,
        scheduleId: String(req.params.scheduleId || ""),
        doctorUserId:
          typeof req.query.doctorId === "string" ? Number(req.query.doctorId) : undefined,
        disabledByUserId: userId,
      })
    );
  } catch (error) {
    console.error("Reception delete session error:", error);
    return handleControllerError(res, error, "Failed to delete session");
  }
};

export const updateReceptionSessionSchedule = async (
  req: AuthenticatedRequest<{
    doctorId?: number | string;
    date?: string;
    start_time?: string;
    end_time?: string;
    slot_duration?: number | string;
    max_patients?: number | string;
    is_active?: boolean;
  }>,
  res: Response
) => {
  try {
    const { medicalCenterId, userId } = requireReceptionContext(req);
    return res.json(
      await updateCenterSchedule({
        medicalCenterId,
        scheduleId: String(req.params.scheduleId || ""),
        doctorUserId:
          req.body?.doctorId === undefined ? undefined : Number(req.body.doctorId),
        date: req.body?.date,
        startTime: req.body?.start_time,
        endTime: req.body?.end_time,
        slotDuration:
          req.body?.slot_duration === undefined ? undefined : Number(req.body.slot_duration),
        maxPatients:
          req.body?.max_patients === undefined ? undefined : Number(req.body.max_patients),
        isActive:
          typeof req.body?.is_active === "boolean" ? req.body.is_active : undefined,
        updatedByUserId: userId,
      })
    );
  } catch (error) {
    console.error("Reception update session error:", error);
    return handleControllerError(res, error, "Failed to update session");
  }
};
