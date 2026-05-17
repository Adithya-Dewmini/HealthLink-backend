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
import { assertVerifiedClinic, assertVerifiedDoctorProfileOnly } from "./verification.service";

type HttpError = Error & { statusCode?: number };

type ScheduleRow = {
  id: number;
  doctor_profile_id: number;
  medical_center_id: string;
  date: string;
  start_time: string;
  end_time: string;
  is_active: boolean;
};

type BookingRecord = {
  id: number;
  doctor_id: number;
  patient_id: number;
  session_id?: number | null;
  medical_center_id?: string | null;
  date: string;
  time: string;
  status: string;
  started_at?: string | null;
  scheduled_at?: string | Date | null;
};

type PatientBookingRow = BookingRecord & {
  doctor_name?: string | null;
  medical_center_name?: string | null;
  session_date?: string | null;
  session_start_time?: string | null;
  session_end_time?: string | null;
  queue_id?: number | null;
  queue_status?: string | null;
  queue_started_at?: string | null;
  queue_ended_at?: string | null;
  queue_patient_status?: string | null;
  queue_token_number?: number | null;
  queue_checked_in_at?: string | null;
  queue_missed_at?: string | null;
  current_serving_token?: number | null;
  waiting_count?: number | null;
};

type PatientActiveQueueOptions = {
  appointmentId?: number | null;
  sessionId?: number | null;
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

const resolveDoctorProfileId = async (doctorIdentifier: number) => {
  const result = await pool.query<{ id: number }>(
    `
    SELECT id
    FROM doctors
    WHERE id = $1 OR user_id = $1
    ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END
    LIMIT 1
    `,
    [doctorIdentifier]
  );

  return result.rows[0]?.id ?? null;
};

const CLOSED_BOOKING_STATUSES = new Set<string>([
  BOOKING_STATUS.CANCELLED,
  BOOKING_STATUS.COMPLETED,
  BOOKING_STATUS.MISSED,
]);

const isClosedBookingStatus = (status: string) => CLOSED_BOOKING_STATUSES.has(status);

const isQueuePatientActive = (status?: string | null) =>
  ["WAITING", "WITH_DOCTOR"].includes(String(status || "").trim().toUpperCase());

const isQueueLive = (status?: string | null) =>
  ["LIVE", "PAUSED"].includes(String(status || "").trim().toUpperCase());

const isTodayDate = (value?: string | null) => {
  if (!value) return false;
  const now = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
  return String(value).slice(0, 10) === current;
};

const isFutureDate = (value?: string | null) => {
  if (!value) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() > today.getTime();
};

const buildSessionTimeLabel = (booking: PatientBookingRow) => {
  const startTime = String(booking.session_start_time || "").slice(0, 5);
  const endTime = String(booking.session_end_time || "").slice(0, 5);
  if (startTime && endTime) return `${startTime} - ${endTime}`;
  if (startTime) return startTime;
  return String(booking.time || "").slice(0, 5) || null;
};

const toPatientQueuePayload = (
  booking: PatientBookingRow | null,
  status: string,
  overrides?: Partial<Record<string, unknown>>
) => {
  if (!booking) {
    return {
      active: false,
      status: "none",
      ...overrides,
    };
  }

  const tokenNumber = Number(booking.queue_token_number ?? 0) || null;
  const currentServingNumber = Number(booking.current_serving_token ?? 0) || null;
  const remainingAhead =
    tokenNumber && currentServingNumber !== null
      ? Math.max(tokenNumber - currentServingNumber - (status === "next" ? 1 : 0), 0)
      : null;

  return {
    active: status !== "none",
    status,
    appointmentId: booking.id,
    queueId: booking.queue_id ?? null,
    doctorId: booking.doctor_id,
    clinicId: booking.medical_center_id ?? null,
    sessionId: booking.session_id ?? null,
    doctorName: booking.doctor_name ?? "Doctor",
    medicalCenterName: booking.medical_center_name ?? "Medical Center",
    scheduledTime: booking.scheduled_at ? new Date(booking.scheduled_at).toISOString() : null,
    sessionTime: buildSessionTimeLabel(booking),
    queueStarted: isQueueLive(booking.queue_status),
    queueStatus: booking.queue_status ?? null,
    patientQueueStatus: booking.queue_patient_status ?? null,
    tokenNumber,
    queueNumber: tokenNumber,
    currentServingNumber,
    currentServingToken: currentServingNumber,
    position: remainingAhead,
    estimatedWaitMinutes:
      remainingAhead !== null ? Math.max(remainingAhead, 0) * 10 : Number(booking.waiting_count ?? 0) * 10,
    waitingCount: Number(booking.waiting_count ?? 0),
    message: null,
    ...overrides,
  };
};

export const listPatientBookings = async (patientId: number) => {
  return syncAndFetchPatientBookings(patientId);
};

export const getPatientActiveQueueState = async (
  patientId: number,
  options: PatientActiveQueueOptions = {}
) => {
  const bookings = (await syncAndFetchPatientBookings(patientId)) as PatientBookingRow[];
  const scopedBookings = bookings.filter((booking) => {
    if (options.appointmentId && Number(booking.id) !== Number(options.appointmentId)) {
      return false;
    }
    if (options.sessionId && Number(booking.session_id) !== Number(options.sessionId)) {
      return false;
    }
    return true;
  });

  if ((options.appointmentId || options.sessionId) && scopedBookings.length === 0) {
    throw createStatusError("Appointment queue details not found", 404);
  }

  const activeQueueBooking =
    scopedBookings.find(
      (booking) =>
        isQueueLive(booking.queue_status) &&
        isQueuePatientActive(booking.queue_patient_status)
    ) ?? null;

  if (activeQueueBooking) {
    const patientQueueStatus = String(activeQueueBooking.queue_patient_status || "").toUpperCase();
    const currentServingNumber = Number(activeQueueBooking.current_serving_token ?? 0) || 0;
    const tokenNumber = Number(activeQueueBooking.queue_token_number ?? 0) || 0;
    const status =
      patientQueueStatus === "MISSED"
        ? "missed"
        : patientQueueStatus === "WITH_DOCTOR" || (tokenNumber > 0 && tokenNumber <= currentServingNumber + 1)
          ? "next"
          : "waiting";

    return toPatientQueuePayload(activeQueueBooking, status, {
      checkInState: "checked_in",
      message:
        status === "next"
          ? "Your turn is close. Please stay near the consultation room."
          : "Queue is active for this appointment.",
    });
  }

  const missedQueueBooking =
    scopedBookings.find(
      (booking) =>
        String(booking.queue_patient_status || "").trim().toUpperCase() === "MISSED" ||
        booking.status === BOOKING_STATUS.MISSED
    ) ?? null;

  if (missedQueueBooking && isTodayDate(missedQueueBooking.date)) {
    return toPatientQueuePayload(missedQueueBooking, "missed", {
      checkInState: "missed",
      message: "This appointment was marked missed.",
    });
  }

  const liveButNotCheckedInBooking =
    scopedBookings.find(
      (booking) =>
        isTodayDate(booking.date) &&
        isQueueLive(booking.queue_status) &&
        !isClosedBookingStatus(booking.status) &&
        !isQueuePatientActive(booking.queue_patient_status)
    ) ?? null;

  if (liveButNotCheckedInBooking) {
    const bookingStatus = normalizeBookingStatus(liveButNotCheckedInBooking.status);
    return toPatientQueuePayload(
      liveButNotCheckedInBooking,
      bookingStatus === BOOKING_STATUS.CONFIRMED ? "check_in_required" : "queue_live",
      {
        checkInState: bookingStatus === BOOKING_STATUS.CONFIRMED ? "pending" : "required",
        message:
          bookingStatus === BOOKING_STATUS.CONFIRMED
            ? "Waiting for receptionist queue check-in."
            : "Check in at reception to join the live queue.",
      }
    );
  }

  const todayAppointment =
    scopedBookings.find(
      (booking) =>
        isTodayDate(booking.date) &&
        !isClosedBookingStatus(booking.status)
    ) ?? null;

  if (todayAppointment) {
    return toPatientQueuePayload(todayAppointment, "today_appointment", {
      checkInState: "not_started",
      message: "Today's appointment is booked. Queue tracking will appear when the session starts.",
    });
  }

  const futureAppointment =
    scopedBookings.find(
      (booking) =>
        isFutureDate(booking.date) &&
        !isClosedBookingStatus(booking.status)
    ) ?? null;

  if (futureAppointment) {
    return toPatientQueuePayload(futureAppointment, "appointment_booked", {
      checkInState: "upcoming",
      message: "Upcoming appointment booked.",
    });
  }

  if (options.appointmentId || options.sessionId) {
    const closedBooking = scopedBookings[0] ?? null;
    if (closedBooking) {
      return toPatientQueuePayload(closedBooking, "none", {
        active: false,
        message: "This appointment is not part of an active queue.",
      });
    }
  }

  return {
    active: false,
    status: "none",
  };
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
  const doctorProfileId = await resolveDoctorProfileId(Number(doctorId));
  if (!doctorProfileId) {
    return [];
  }

  const result = await pool.query(
    `
    SELECT time
    FROM bookings
    WHERE doctor_id = $1 AND medical_center_id = $2 AND date = $3
      AND COALESCE(UPPER(status), '') <> '${BOOKING_STATUS.CANCELLED}'
    `,
    [doctorProfileId, clinicId, date]
  );

  return result.rows;
};

export const createPatientBooking = async (
  patientId: number,
  doctorId: number,
  clinicId: string,
  date: string,
  time: string,
  sessionId?: number | null
) => {
  if (process.env.NODE_ENV !== "production") {
    console.log("PATIENT_BOOKING_REQUEST", {
      patientId,
      doctorId,
      clinicId,
      sessionId: sessionId ?? null,
      date,
      time,
    });
  }

  const doctorProfileId = await resolveDoctorProfileId(doctorId);
  if (!doctorProfileId) {
    throw createStatusError("Doctor not found", 404);
  }

  await assertVerifiedDoctorProfileOnly(doctorProfileId);
  await assertVerifiedClinic(clinicId);

  const validation = await validateBookingSlot({ doctorId: doctorProfileId, clinicId, date, time });
  if (validation.ok === false) {
    throw createStatusError(validation.message, 400);
  }

  let resolvedSessionId = sessionId ?? null;

  if (resolvedSessionId) {
    const sessionResult = await pool.query<ScheduleRow>(
      `
      SELECT
        id,
        doctor_profile_id,
        medical_center_id,
        date::text AS date,
        start_time::text AS start_time,
        end_time::text AS end_time,
        is_active
      FROM medical_center_doctor_schedule
      WHERE id = $1
      LIMIT 1
      `,
      [resolvedSessionId]
    );

    const session = sessionResult.rows[0];
    if (!session) {
      throw createStatusError("Selected clinic session was not found", 404);
    }

    if (!session.is_active) {
      throw createStatusError("Selected clinic session is no longer active", 400);
    }

    if (session.medical_center_id !== clinicId) {
      const error = createStatusError("Selected clinic session does not belong to this medical center", 400) as HttpError & {
        debug?: Record<string, unknown>;
      };
      error.debug = {
        requestedMedicalCenterId: clinicId,
        requestedDoctorId: doctorId,
        resolvedDoctorProfileId: doctorProfileId,
        selectedScheduleId: resolvedSessionId,
        scheduleMedicalCenterId: session.medical_center_id,
        scheduleDoctorProfileId: session.doctor_profile_id,
        scheduleDate: session.date,
        scheduleStartTime: session.start_time,
        scheduleEndTime: session.end_time,
      };
      throw error;
    }

    if (session.doctor_profile_id !== doctorProfileId) {
      throw createStatusError("Selected clinic session does not belong to this doctor", 400);
    }

    if (session.date !== date) {
      throw createStatusError("Selected clinic session does not match the chosen date", 400);
    }

    if (!(String(session.start_time).slice(0, 5) <= time && String(session.end_time).slice(0, 5) > time)) {
      throw createStatusError("Selected time is outside the chosen clinic session", 400);
    }
  } else {
    resolvedSessionId = await resolveSessionIdForBooking(doctorProfileId, clinicId, date, time);
  }

  if (!resolvedSessionId) {
    throw createStatusError("No session available for the requested slot", 400);
  }

  return bookUnifiedSession(resolvedSessionId, patientId, time);
};
