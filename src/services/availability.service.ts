import pool from "../config/db";
import { io } from "../server";
import { markInvalidClinicSchedulesForDoctor } from "./schedule.service";

type AppError = Error & { statusCode?: number };

export type AvailabilityDayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type AvailabilitySlotInput = {
  id?: string | number;
  start: string;
  end: string;
};

export type AvailabilityStateInput = Partial<Record<AvailabilityDayKey, AvailabilitySlotInput[]>>;
export type AvailabilityEnabledDaysInput = AvailabilityDayKey[];

type DoctorRow = {
  id: number;
};

type AvailabilityRow = {
  id: number;
  day: string;
  day_of_week: number | null;
  start_time: string;
  end_time: string;
  is_active: boolean | null;
};

type WorkingDayRow = {
  day: string;
};

const DAY_KEYS: AvailabilityDayKey[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const DAY_NAME_BY_KEY: Record<AvailabilityDayKey, string> = {
  sunday: "Sunday",
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
};

const MAX_SLOTS_PER_DAY = 4;

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
};

const doctorRoom = (doctorId: number | string) => `doctor_${doctorId}`;
const legacyDoctorRoom = (doctorId: number | string) => `doctor-${doctorId}`;

const normalizeTime = (value: unknown) => String(value || "").trim().slice(0, 5);

const parseTimeToMinutes = (value: string) => {
  const normalized = normalizeTime(value);
  const match = normalized.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    throw createStatusError("Time must be in HH:MM format", 400);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) {
    throw createStatusError("Invalid time value", 400);
  }

  return hours * 60 + minutes;
};

const getDoctorProfileIdByUserId = async (userId: number) => {
  const result = await pool.query<DoctorRow>(
    `
      SELECT id
      FROM doctors
      WHERE user_id = $1
      LIMIT 1
    `,
    [userId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Doctor profile not found", 404);
  }

  return result.rows[0].id;
};

const createEmptyAvailabilityState = () =>
  DAY_KEYS.reduce<Record<AvailabilityDayKey, Array<{ id: string; start: string; end: string }>>>(
    (accumulator, dayKey) => {
      accumulator[dayKey] = [];
      return accumulator;
    },
    {} as Record<AvailabilityDayKey, Array<{ id: string; start: string; end: string }>>
  );

const toDayKey = (dayName: string | null, dayOfWeek: number | null): AvailabilityDayKey => {
  if (typeof dayOfWeek === "number" && DAY_KEYS[dayOfWeek]) {
    return DAY_KEYS[dayOfWeek];
  }

  const normalized = String(dayName || "").trim().toLowerCase();
  if (normalized in DAY_NAME_BY_KEY) {
    return normalized as AvailabilityDayKey;
  }

  throw createStatusError("Invalid availability day", 400);
};

const validateDailySlots = (dayKey: AvailabilityDayKey, slots: AvailabilitySlotInput[]) => {
  if (slots.length > MAX_SLOTS_PER_DAY) {
    throw createStatusError(
      `You can only save up to ${MAX_SLOTS_PER_DAY} slots for ${DAY_NAME_BY_KEY[dayKey]}`,
      400
    );
  }

  const normalized = slots.map((slot) => ({
    id: slot.id,
    start: normalizeTime(slot.start),
    end: normalizeTime(slot.end),
  }));

  normalized.forEach((slot) => {
    const start = parseTimeToMinutes(slot.start);
    const end = parseTimeToMinutes(slot.end);

    if (start >= end) {
      throw createStatusError(`Invalid time range for ${DAY_NAME_BY_KEY[dayKey]}`, 400);
    }
  });

  const sorted = [...normalized].sort((left, right) => left.start.localeCompare(right.start));

  for (let index = 0; index < sorted.length - 1; index += 1) {
    if (sorted[index].end > sorted[index + 1].start) {
      throw createStatusError(`Overlapping availability slots found for ${DAY_NAME_BY_KEY[dayKey]}`, 400);
    }
  }
};

const broadcastAvailabilityUpdate = (doctorUserId: number) => {
  const payload = { doctorId: doctorUserId, type: "availability" };
  io.to(doctorRoom(doctorUserId)).emit("schedule:update", payload);
  io.to(legacyDoctorRoom(doctorUserId)).emit("schedule:update", payload);
};

export const getDoctorAvailabilityState = async (doctorUserId: number) => {
  const doctorProfileId = await getDoctorProfileIdByUserId(doctorUserId);
  const [result, workingDaysResult] = await Promise.all([
    pool.query<AvailabilityRow>(
      `
        SELECT id, day, day_of_week, start_time, end_time, COALESCE(is_active, TRUE) AS is_active
        FROM doctor_availability
        WHERE doctor_id = $1
          AND COALESCE(is_active, TRUE) = TRUE
        ORDER BY COALESCE(day_of_week, 7), start_time ASC
      `,
      [doctorProfileId]
    ),
    pool.query<WorkingDayRow>(
      `
        SELECT day
        FROM doctor_working_days
        WHERE doctor_id = $1
      `,
      [doctorProfileId]
    ),
  ]);

  const availability = createEmptyAvailabilityState();
  const enabledDaySet = new Set<AvailabilityDayKey>();

  result.rows.forEach((row) => {
    const dayKey = toDayKey(row.day, row.day_of_week);
    enabledDaySet.add(dayKey);
    availability[dayKey].push({
      id: String(row.id),
      start: normalizeTime(row.start_time),
      end: normalizeTime(row.end_time),
    });
  });

  workingDaysResult.rows.forEach((row) => {
    const normalized = String(row.day || "").trim().toLowerCase();
    if (normalized in DAY_NAME_BY_KEY) {
      enabledDaySet.add(normalized as AvailabilityDayKey);
    }
  });

  const todayKey = DAY_KEYS[new Date().getDay()];

  return {
    availability,
    availableToday: availability[todayKey].length > 0,
    enabledDays: DAY_KEYS.filter((dayKey) => enabledDaySet.has(dayKey)),
  };
};

export const createDoctorAvailabilitySlot = async (
  doctorUserId: number,
  input: { dayOfWeek: number; startTime: string; endTime: string }
) => {
  if (!Number.isInteger(input.dayOfWeek) || input.dayOfWeek < 0 || input.dayOfWeek > 6) {
    throw createStatusError("day_of_week must be between 0 and 6", 400);
  }

  const doctorProfileId = await getDoctorProfileIdByUserId(doctorUserId);
  const dayKey = DAY_KEYS[input.dayOfWeek];
  validateDailySlots(dayKey, [{ start: input.startTime, end: input.endTime }]);

  const overlapResult = await pool.query(
    `
      SELECT id, start_time, end_time
      FROM doctor_availability
      WHERE doctor_id = $1
        AND COALESCE(is_active, TRUE) = TRUE
        AND COALESCE(day_of_week, -1) = $2
      ORDER BY start_time ASC
    `,
    [doctorProfileId, input.dayOfWeek]
  );

  if (overlapResult.rows.length >= MAX_SLOTS_PER_DAY) {
    throw createStatusError(
      `You can only save up to ${MAX_SLOTS_PER_DAY} slots for ${DAY_NAME_BY_KEY[dayKey]}`,
      400
    );
  }

  const normalizedStartTime = normalizeTime(input.startTime);
  const normalizedEndTime = normalizeTime(input.endTime);

  const hasConflict = overlapResult.rows.some((row: { id: number; start_time?: string; end_time?: string }) => {
    const existingStart = parseTimeToMinutes(String(row.start_time || ""));
    const existingEnd = parseTimeToMinutes(String(row.end_time || ""));
    const requestedStart = parseTimeToMinutes(normalizedStartTime);
    const requestedEnd = parseTimeToMinutes(normalizedEndTime);
    return requestedStart < existingEnd && requestedEnd > existingStart;
  });

  if (hasConflict) {
    throw createStatusError("Time slot overlaps with existing availability", 400);
  }

  await pool.query(
    `
      INSERT INTO doctor_availability (
        doctor_id,
        day,
        day_of_week,
        start_time,
        end_time,
        is_active
      )
      VALUES ($1, $2, $3, $4::time, $5::time, TRUE)
    `,
    [doctorProfileId, DAY_NAME_BY_KEY[dayKey], input.dayOfWeek, normalizedStartTime, normalizedEndTime]
  );

  await pool.query(
    `
      INSERT INTO doctor_working_days (doctor_id, day)
      VALUES ($1, $2)
      ON CONFLICT (doctor_id, day) DO NOTHING
    `,
    [doctorProfileId, DAY_NAME_BY_KEY[dayKey]]
  );

  await markInvalidClinicSchedulesForDoctor({ doctorProfileId });
  broadcastAvailabilityUpdate(doctorUserId);

  return getDoctorAvailabilityState(doctorUserId);
};

export const replaceDoctorAvailabilityState = async (
  doctorUserId: number,
  state: AvailabilityStateInput,
  enabledDaysInput: AvailabilityEnabledDaysInput = []
) => {
  const doctorProfileId = await getDoctorProfileIdByUserId(doctorUserId);
  const normalizedEnabledDays = Array.from(
    new Set(
      enabledDaysInput.filter(
        (dayKey): dayKey is AvailabilityDayKey => typeof dayKey === "string" && DAY_KEYS.includes(dayKey as AvailabilityDayKey)
      )
    )
  );

  for (const dayKey of DAY_KEYS) {
    validateDailySlots(dayKey, Array.isArray(state[dayKey]) ? state[dayKey]! : []);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`DELETE FROM doctor_working_days WHERE doctor_id = $1`, [doctorProfileId]);

    const persistedEnabledDays = Array.from(
      new Set(
        DAY_KEYS.filter(
          (dayKey) => normalizedEnabledDays.includes(dayKey) || (Array.isArray(state[dayKey]) && state[dayKey]!.length > 0)
        )
      )
    );

    for (const dayKey of persistedEnabledDays) {
      await client.query(
        `
          INSERT INTO doctor_working_days (doctor_id, day)
          VALUES ($1, $2)
          ON CONFLICT (doctor_id, day) DO NOTHING
        `,
        [doctorProfileId, DAY_NAME_BY_KEY[dayKey]]
      );
    }

    const existingResult = await client.query<AvailabilityRow>(
      `
        SELECT id, day, day_of_week, start_time, end_time, COALESCE(is_active, TRUE) AS is_active
        FROM doctor_availability
        WHERE doctor_id = $1
      `,
      [doctorProfileId]
    );

    const existingIds = new Set(existingResult.rows.map((row) => String(row.id)));
    const seenIds = new Set<string>();

    for (const [dayOfWeek, dayKey] of DAY_KEYS.entries()) {
      const slots = Array.isArray(state[dayKey]) ? state[dayKey]! : [];

      for (const slot of slots) {
        const normalizedStart = normalizeTime(slot.start);
        const normalizedEnd = normalizeTime(slot.end);
        const incomingId = slot.id !== undefined && slot.id !== null ? String(slot.id) : null;

        if (incomingId && existingIds.has(incomingId)) {
          await client.query(
            `
              UPDATE doctor_availability
              SET day = $1,
                  day_of_week = $2,
                  start_time = $3::time,
                  end_time = $4::time,
                  is_active = TRUE,
                  updated_at = NOW()
              WHERE id = $5::int
                AND doctor_id = $6
            `,
            [DAY_NAME_BY_KEY[dayKey], dayOfWeek, normalizedStart, normalizedEnd, incomingId, doctorProfileId]
          );
          seenIds.add(incomingId);
          continue;
        }

        const insertResult = await client.query<{ id: number }>(
          `
            INSERT INTO doctor_availability (
              doctor_id,
              day,
              day_of_week,
              start_time,
              end_time,
              is_active
            )
            VALUES ($1, $2, $3, $4::time, $5::time, TRUE)
            RETURNING id
          `,
          [doctorProfileId, DAY_NAME_BY_KEY[dayKey], dayOfWeek, normalizedStart, normalizedEnd]
        );

        seenIds.add(String(insertResult.rows[0].id));
      }
    }

    const staleIds = existingResult.rows
      .map((row) => String(row.id))
      .filter((id) => !seenIds.has(id));

    if (staleIds.length > 0) {
      await client.query(
        `
          UPDATE doctor_availability
          SET is_active = FALSE,
              updated_at = NOW()
          WHERE doctor_id = $1
            AND id = ANY($2::int[])
        `,
        [doctorProfileId, staleIds.map((value) => Number(value))]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await markInvalidClinicSchedulesForDoctor({ doctorProfileId });
  broadcastAvailabilityUpdate(doctorUserId);
  return getDoctorAvailabilityState(doctorUserId);
};
