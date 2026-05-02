import pool from "../config/db";
import { env } from "../config/env";

const APP_TZ = env.appTz;
const APP_TIME_SQL = `(now() AT TIME ZONE '${APP_TZ}')::time`;
const APP_DATE_SQL = `(now() AT TIME ZONE '${APP_TZ}')::date`;

type DoctorIdRow = { id: number };
type QueueRow = {
  id: number;
  doctor_id: number;
  status: string;
  shift_id: number | null;
  shift_date: string;
  medical_center_id: string | null;
  started_at?: string | null;
};
type ShiftRow = { id: number };

type Queryable = {
  query: <TRow = any>(text: string, params?: unknown[]) => Promise<{ rows: TRow[] }>;
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
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
    throw createStatusError("Doctor profile not found", 404);
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
