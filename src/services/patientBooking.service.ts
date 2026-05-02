import pool from "../config/db";
import {
  BOOKING_STATUS,
  DEFAULT_BOOKING_GRACE_PERIOD_MINUTES,
  markMissedBookings,
  normalizeBookingStatus,
} from "../utils/bookingLifecycle";
import { syncAndFetchPatientBookings } from "../modules/appointments/service";
import { validateBookingSlot } from "../modules/appointments/validation";
import { bookUnifiedSession, resolveSessionIdForBooking } from "./unifiedSession.service";

type HttpError = Error & { statusCode?: number };

type BookingRecord = {
  id: number;
  doctor_id: number;
  patient_id: number;
  medical_center_id?: string | null;
  date: string;
  time: string;
  status: string;
  started_at?: string | null;
  scheduled_at?: string | Date | null;
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

const toValidDate = (value: string | Date | null | undefined) => {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const listPatientBookings = async (patientId: number) => {
  return syncAndFetchPatientBookings(patientId);
};

export const cancelPatientBooking = async (patientId: number, bookingId: number) => {
  await markMissedBookings(pool, { patientId, bookingId });

  const bookingResult = await pool.query<BookingRecord>(
    `
    SELECT id,
           doctor_id,
           patient_id,
           medical_center_id,
           date,
           time,
           status,
           started_at,
           COALESCE(scheduled_at, ((date::timestamp) + time)) AS scheduled_at
    FROM bookings
    WHERE id = $1 AND patient_id = $2
    `,
    [bookingId, patientId]
  );

  const booking = bookingResult.rows[0];
  if (!booking) {
    throw createStatusError("Booking not found", 404);
  }

  const status = normalizeBookingStatus(booking.status);
  if (status === BOOKING_STATUS.CANCELLED) {
    throw createStatusError("Booking already cancelled", 400);
  }
  if (status === BOOKING_STATUS.COMPLETED) {
    throw createStatusError("Completed appointments cannot be cancelled", 400);
  }
  if (status === BOOKING_STATUS.MISSED) {
    throw createStatusError("Missed appointments cannot be cancelled", 400);
  }

  const scheduledAt = toValidDate(booking.scheduled_at);
  if (
    booking.started_at ||
    !scheduledAt ||
    scheduledAt.getTime() <= Date.now()
  ) {
    throw createStatusError("Cannot cancel an appointment that has already started", 400);
  }

  await pool.query(
    `
    UPDATE bookings
    SET status = $2
    WHERE id = $1
    `,
    [bookingId, BOOKING_STATUS.CANCELLED]
  );

  console.log("STATUS CHANGE:", bookingId, status, BOOKING_STATUS.CANCELLED);
};

export const reschedulePatientBooking = async (
  patientId: number,
  bookingId: number,
  date: string,
  time: string
) => {
  await markMissedBookings(pool, { patientId, bookingId });

  const bookingResult = await pool.query<BookingRecord>(
    `
    SELECT id,
           doctor_id,
           patient_id,
           medical_center_id,
           date,
           time,
           status,
           COALESCE(scheduled_at, ((date::timestamp) + time)) AS scheduled_at
    FROM bookings
    WHERE id = $1 AND patient_id = $2
    `,
    [bookingId, patientId]
  );

  const booking = bookingResult.rows[0];
  if (!booking) {
    throw createStatusError("Booking not found", 404);
  }

  const status = normalizeBookingStatus(booking.status);
  if (status === BOOKING_STATUS.CANCELLED) {
    throw createStatusError("Cancelled bookings cannot be rescheduled", 400);
  }
  if (status === BOOKING_STATUS.COMPLETED) {
    throw createStatusError("Completed appointments cannot be rescheduled", 400);
  }
  if (status === BOOKING_STATUS.MISSED) {
    throw createStatusError("Missed appointments cannot be rescheduled", 400);
  }
  if (status !== BOOKING_STATUS.BOOKED) {
    throw createStatusError("Only booked appointments can be rescheduled", 400);
  }

  const originalDate = toValidDate(booking.scheduled_at);
  if (!originalDate || originalDate.getTime() <= Date.now()) {
    throw createStatusError("Reschedule is only allowed before the scheduled time", 400);
  }

  const validation = await validateBookingSlot({
    doctorId: Number(booking.doctor_id),
    clinicId: String((booking as BookingRecord & { medical_center_id?: string | null }).medical_center_id || ""),
    date,
    time,
    excludeBookingId: bookingId,
  });
  if (validation.ok === false) {
    throw createStatusError(validation.message, 400);
  }

  const conflictResult = await pool.query(
    `
    SELECT 1 FROM bookings
    WHERE doctor_id = $1 AND date = $2 AND time = $3 AND id <> $4
      AND COALESCE(UPPER(status), '') <> '${BOOKING_STATUS.CANCELLED}'
    LIMIT 1
    `,
    [booking.doctor_id, date, time, bookingId]
  );
  if (conflictResult.rows.length > 0) {
    throw createStatusError("Slot already booked", 409);
  }

  const sessionId = await resolveSessionIdForBooking(
    Number(booking.doctor_id),
    String(booking.medical_center_id || ""),
    date,
    time
  );

  if (!sessionId) {
    throw createStatusError("No session available for the requested slot", 400);
  }

  await pool.query(
    `
    UPDATE bookings
    SET date = $1,
        time = $2,
        session_id = $5,
        scheduled_at = (($1::date)::timestamp + $2::time),
        status = $4,
        started_at = NULL,
        ended_at = NULL,
        missed_at = NULL
    WHERE id = $3
    `,
    [date, time, bookingId, BOOKING_STATUS.BOOKED, sessionId]
  );
};

export const listDoctorBookedSlots = async (doctorId: string, clinicId: string, date: string) => {
  const result = await pool.query(
    `
    SELECT time
    FROM bookings
    WHERE doctor_id = $1 AND medical_center_id = $2 AND date = $3
      AND COALESCE(UPPER(status), '') <> '${BOOKING_STATUS.CANCELLED}'
    `,
    [doctorId, clinicId, date]
  );

  return result.rows;
};

export const createPatientBooking = async (
  patientId: number,
  doctorId: number,
  clinicId: string,
  date: string,
  time: string
) => {
  const validation = await validateBookingSlot({ doctorId, clinicId, date, time });
  if (validation.ok === false) {
    throw createStatusError(validation.message, 400);
  }

  const sessionId = await resolveSessionIdForBooking(doctorId, clinicId, date, time);
  if (!sessionId) {
    throw createStatusError("No session available for the requested slot", 400);
  }

  return bookUnifiedSession(sessionId, patientId, time);
};
