import pool from "../../config/db";
import { BOOKING_STATUS } from "../../utils/bookingLifecycle";
import type { BookingActionValidationResult, BookingSlotValidationInput } from "./types";
import {
  findBookableClinicSessionByTime,
  isTimeWithinSessionSlots,
} from "../../services/sessionDomain.service";

const DATE_INPUT_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_INPUT_REGEX = /^\d{2}:\d{2}$/;

export const parsePositiveId = (value: unknown) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const validateBookingMutationPayload = (date: unknown, time: unknown): BookingActionValidationResult => {
  const normalizedDate = String(date ?? "").trim();
  const normalizedTime = String(time ?? "").trim();

  if (!DATE_INPUT_REGEX.test(normalizedDate)) {
    return { ok: false, message: "date must be in YYYY-MM-DD format" };
  }
  if (!TIME_INPUT_REGEX.test(normalizedTime)) {
    return { ok: false, message: "time must be in HH:MM format" };
  }
  if (!isRealCalendarDate(normalizedDate)) {
    return { ok: false, message: "date must be a valid calendar date" };
  }
  if (parseMinutes(normalizedTime) == null) {
    return { ok: false, message: "time must be a valid 24-hour HH:MM value" };
  }

  return { ok: true };
};

const parseMinutes = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
};

const isRealCalendarDate = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() + 1 === month &&
    parsed.getDate() === day
  );
};

export const validateBookingSlot = async ({
  doctorId,
  clinicId,
  date,
  time,
  excludeBookingId,
}: BookingSlotValidationInput): Promise<BookingActionValidationResult> => {
  const payloadValidation = validateBookingMutationPayload(date, time);
  if (!payloadValidation.ok) {
    return payloadValidation;
  }

  const requestDate = new Date(`${date}T${time}:00`);
  if (Number.isNaN(requestDate.getTime())) {
    return { ok: false, message: "Invalid date or time format" };
  }
  if (requestDate.getTime() < Date.now()) {
    return { ok: false, message: "Cannot book slots in the past" };
  }

  const session = await findBookableClinicSessionByTime(pool, {
    doctorProfileId: doctorId,
    clinicId,
    date,
    time,
  });
  if (session) {
    if (!isTimeWithinSessionSlots(time, session)) {
      return { ok: false, message: "Requested time is not part of this clinic session" };
    }

    if (session.slot_duration <= 0) {
      return { ok: false, message: "Clinic session is not configured correctly" };
    }

    const bookedCountResult = await pool.query(
      `
      SELECT COUNT(*) AS booked_count
      FROM bookings
      WHERE session_id = $1
        AND COALESCE(UPPER(status), '') NOT IN ('CANCELLED', 'MISSED')
        ${excludeBookingId ? "AND id <> $2" : ""}
      `,
      excludeBookingId ? [session.id, excludeBookingId] : [session.id]
    );

    const bookedCount = Number(bookedCountResult.rows[0]?.booked_count ?? 0);
    if (bookedCount >= session.max_patients) {
      return { ok: false, message: "No slots available for this clinic session" };
    }

    return { ok: true };
  }
  return { ok: false, message: "No clinic-defined session is available for this slot" };
};
