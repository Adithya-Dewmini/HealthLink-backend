import pool from "../config/db";
import { env } from "../config/env";

const APP_TZ = env.appTz;
const APP_TIME_SQL = `(now() AT TIME ZONE '${APP_TZ}')::time`;
const APP_DATE_SQL = `(now() AT TIME ZONE '${APP_TZ}')::date`;
const APPROVED_CENTER_SQL = `
  (
    LOWER(COALESCE(mc.verification_status, 'pending')) = 'approved'
    OR (
      LOWER(COALESCE(mc.verification_status, 'pending')) = 'pending'
      AND LOWER(COALESCE(mc.status, '')) = 'approved'
    )
  )
  AND LOWER(COALESCE(mc.status, 'active')) IN ('active', 'approved')
`;

type DoctorIdRow = { id: number };
type QueueRow = {
  id: number;
  doctor_id: number;
  status: string;
  shift_id: number | null;
  schedule_id?: number | null;
  shift_date: string;
  medical_center_id: string | null;
  started_at?: string | null;
};
type ShiftRow = { id: number };
type StartableScheduleRow = {
  id: number;
  medical_center_id: string;
  start_time: string;
  end_time: string;
};

type Queryable = {
  query: <TRow = any>(text: string, params?: unknown[]) => Promise<{ rows: TRow[] }>;
};

const createStatusError = (message: string, statusCode: number, code?: string) => {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

export const doctorQueueSql = {
  APP_TZ,
  APP_TIME_SQL,
  APP_DATE_SQL,
};

export const requireDoctorIdForUser = async (userId: number, db: Queryable = pool) => {
  const result = await db.query<DoctorIdRow>(`SELECT id FROM doctors WHERE user_id = $1`, [userId]);
  const doctorId = result.rows[0]?.id ?? null;

  if (!doctorId) {
    throw createStatusError("Doctor profile not found", 404, "DOCTOR_NOT_ASSIGNED");
  }

  return doctorId;
};

export const resolveStartableShiftId = async (
  doctorId: number,
  requestedShiftId?: number | string | null,
  db: Queryable = pool
) => {
  const dayName = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: APP_TZ,
  });

  if (requestedShiftId) {
    const requestedShift = await db.query<ShiftRow>(
      `
      SELECT id
      FROM doctor_availability
      WHERE id = $1
        AND doctor_id = $2
        AND day = $3
        AND ${APP_TIME_SQL} >= (start_time - interval '30 minutes')
        AND ${APP_TIME_SQL} <= end_time
      LIMIT 1
      `,
      [requestedShiftId, doctorId, dayName]
    );

    return requestedShift.rows[0]?.id ?? null;
  }

  const activeShift = await db.query<ShiftRow>(
    `
    SELECT id
    FROM doctor_availability
    WHERE doctor_id = $1
      AND day = $2
      AND ${APP_TIME_SQL} >= (start_time - interval '30 minutes')
      AND ${APP_TIME_SQL} <= end_time
    ORDER BY start_time
    LIMIT 1
    `,
    [doctorId, dayName]
  );

  return activeShift.rows[0]?.id ?? null;
};

export const resolveStartableSchedule = async (
  doctorId: number,
  requestedScheduleId?: number | string | null,
  db: Queryable = pool
) => {
  if (requestedScheduleId) {
    const requestedSchedule = await db.query<StartableScheduleRow>(
      `
      SELECT s.id, s.medical_center_id, s.start_time::text AS start_time, s.end_time::text AS end_time
      FROM medical_center_doctor_schedule s
      JOIN medical_centers mc ON mc.id = s.medical_center_id
      WHERE s.id = $1
        AND s.doctor_profile_id = $2
        AND ${APPROVED_CENTER_SQL}
        AND date = ${APP_DATE_SQL}
        AND is_active = TRUE
      LIMIT 1
      `,
      [requestedScheduleId, doctorId]
    );

    return requestedSchedule.rows[0] ?? null;
  }

  const activeOrUpcomingSchedule = await db.query<StartableScheduleRow>(
    `
    SELECT s.id, s.medical_center_id, s.start_time::text AS start_time, s.end_time::text AS end_time
    FROM medical_center_doctor_schedule s
    JOIN medical_centers mc ON mc.id = s.medical_center_id
    WHERE s.doctor_profile_id = $1
      AND s.date = ${APP_DATE_SQL}
      AND s.is_active = TRUE
      AND s.end_time >= ${APP_TIME_SQL}
      AND ${APPROVED_CENTER_SQL}
    ORDER BY
      CASE WHEN s.start_time <= ${APP_TIME_SQL} AND s.end_time >= ${APP_TIME_SQL} THEN 0 ELSE 1 END,
      s.start_time ASC
    LIMIT 1
    `,
    [doctorId]
  );

  return activeOrUpcomingSchedule.rows[0] ?? null;
};

export const getLatestQueueForDoctorToday = async (doctorId: number, db: Queryable = pool) => {
  const result = await db.query<QueueRow>(
    `
    SELECT *
    FROM queues
    WHERE doctor_id = $1
      AND shift_date = ${APP_DATE_SQL}
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [doctorId]
  );

  return result.rows[0] ?? null;
};

export const getLiveQueueForDoctorToday = async (doctorId: number, db: Queryable = pool) => {
  const result = await db.query<QueueRow>(
    `
    SELECT *
    FROM queues
    WHERE doctor_id = $1
      AND shift_date = ${APP_DATE_SQL}
      AND status = 'LIVE'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [doctorId]
  );

  return result.rows[0] ?? null;
};
