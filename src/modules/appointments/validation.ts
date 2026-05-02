import pool from "../../config/db";
import { env } from "../../config/env";
import { BOOKING_STATUS } from "../../utils/bookingLifecycle";
import type { BookingActionValidationResult, BookingSlotValidationInput } from "./types";

const APP_TZ = env.appTz;

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

  return { ok: true };
};

const parseMinutes = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

const buildSlotSet = (
  availability: { start_time: string; end_time: string; max_patients?: number | null }[]
) => {
  const slotSet = new Set<string>();
  for (const item of availability) {
    const start = String(item.start_time).slice(0, 5);
    const end = String(item.end_time).slice(0, 5);
    const count = Number(item.max_patients ?? 0);
    const startMinutes = parseMinutes(start);
    const endMinutes = parseMinutes(end);
    if (!count || count <= 0 || startMinutes == null || endMinutes == null) continue;

    const interval = (endMinutes - startMinutes) / count;
    if (interval <= 0) continue;

    for (let i = 0; i < count; i += 1) {
      const minutes = Math.round(startMinutes + interval * i);
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      slotSet.add(`${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`);
    }
  }
  return slotSet;
};

export const validateBookingSlot = async ({
  doctorId,
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

  const dayName = requestDate.toLocaleDateString("en-US", { weekday: "long", timeZone: APP_TZ });

  const [workingDaysResult, availabilityResult] = await Promise.all([
    pool.query(`SELECT day FROM doctor_working_days WHERE doctor_id = $1`, [doctorId]),
    pool.query(
      `
      SELECT start_time, end_time, max_patients
      FROM doctor_availability
      WHERE doctor_id = $1 AND day = $2
      `,
      [doctorId, dayName]
    ),
  ]);

  const workingDays = workingDaysResult.rows.map((row) => String(row.day));
  if (workingDays.length > 0 && !workingDays.includes(dayName)) {
    return { ok: false, message: "Doctor is not available on this day" };
  }

  const availability = Array.isArray(availabilityResult.rows) ? availabilityResult.rows : [];
  if (availability.length === 0) {
    return { ok: false, message: "No availability for this day" };
  }

  const requestedMinutes = parseMinutes(String(time).slice(0, 5));
  if (requestedMinutes == null) {
    return { ok: false, message: "Invalid time format" };
  }

  const slotSet = buildSlotSet(availability);
  if (!slotSet.has(String(time).slice(0, 5))) {
    return { ok: false, message: "Requested time is not available" };
  }

  const capacity = slotSet.size;
  if (capacity > 0) {
    const bookedCountResult = await pool.query(
      `
      SELECT COUNT(*) AS booked_count
      FROM bookings
      WHERE doctor_id = $1 AND date = $2
        AND COALESCE(UPPER(status), '') <> '${BOOKING_STATUS.CANCELLED}'
        ${excludeBookingId ? "AND id <> $3" : ""}
      `,
      excludeBookingId ? [doctorId, date, excludeBookingId] : [doctorId, date]
    );

    const bookedCount = Number(bookedCountResult.rows[0]?.booked_count ?? 0);
    if (bookedCount >= capacity) {
      return { ok: false, message: "No slots available for this day" };
    }
  }

  return { ok: true };
};
