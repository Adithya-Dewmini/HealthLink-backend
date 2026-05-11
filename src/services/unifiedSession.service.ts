import pool from "../config/db";
import { BOOKING_STATUS } from "../utils/bookingLifecycle";
import { findClinicSessionById } from "./sessionDomain.service";

type SessionRow = {
  id: number;
  doctor_profile_id: number;
  medical_center_id: string;
  date: string;
};

type BookingRow = {
  id: number;
  doctor_id: number;
  patient_id: number;
  medical_center_id: string;
  date: string;
  time: string;
  status: string;
  session_id: number;
  scheduled_at: string;
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  return error;
};

export const resolveSessionIdForBooking = async (
  doctorId: number,
  clinicId: string,
  date: string,
  time: string
) => {
  const result = await pool.query<{ id: number }>(
    `
    SELECT id
    FROM medical_center_doctor_schedule
    WHERE doctor_profile_id = $1
      AND medical_center_id = $2
      AND date = $3::date
      AND start_time <= $4::time
      AND end_time > $4::time
      AND is_active = TRUE
    ORDER BY start_time ASC
    LIMIT 1
    `,
    [doctorId, clinicId, date, time]
  );

  return result.rows[0]?.id ?? null;
};

export const bookUnifiedSession = async (sessionId: number, patientId: number, time: string) => {
  const session = await findClinicSessionById(pool, sessionId);
  if (!session) {
    throw createStatusError("Session not found", 404);
  }

  const existingResult = await pool.query<{ id: number }>(
    `
    SELECT id
    FROM bookings
    WHERE patient_id = $1
      AND session_id = $2
      AND COALESCE(UPPER(status), '') <> '${BOOKING_STATUS.CANCELLED}'
    LIMIT 1
    `,
    [patientId, sessionId]
  );

  if (existingResult.rows[0]?.id) {
    throw createStatusError("Patient already booked for this session", 409);
  }

  const bookingResult = await pool.query<BookingRow>(
    `
    INSERT INTO bookings (
      doctor_id,
      patient_id,
      medical_center_id,
      date,
      time,
      status,
      session_id,
      scheduled_at
    )
    VALUES ($1, $2, $3, $4::date, $5::time, $6, $7, (($4::date)::timestamp + $5::time))
    RETURNING
      id,
      doctor_id,
      patient_id,
      medical_center_id,
      date::text AS date,
      time::text AS time,
      status,
      session_id,
      scheduled_at::text AS scheduled_at
    `,
    [
      session.doctor_profile_id,
      patientId,
      session.medical_center_id,
      session.date,
      time,
      BOOKING_STATUS.BOOKED,
      sessionId,
    ]
  );

  return bookingResult.rows[0];
};
