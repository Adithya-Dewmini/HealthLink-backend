import type { PoolClient } from "pg";
import pool from "../config/db";
import { env } from "../config/env";
import { io } from "../server";
import { getDoctorAvailabilityState } from "./availability.service";
import { emitClinicPublicScheduleUpdate } from "./clinicRealtime.service";

type AppError = Error & { statusCode?: number; details?: string[] };

export type ScheduleOverviewItem = {
  type: "AVAILABLE" | "CLINIC" | "BLOCKED";
  date: string;
  start: string;
  end: string;
  clinicId?: string | null;
  clinicName?: string | null;
  clinicType?: string | null;
  location?: string | null;
  cover_image_url?: string | null;
  logo_url?: string | null;
  scheduleId?: number | null;
  patientsCount?: number | null;
  maxPatients?: number | null;
  slotDuration?: number | null;
  reason?: string | null;
};

export type CreateCenterScheduleInput = {
  medicalCenterId: string;
  doctorUserId: number;
  date: string;
  startTime: string;
  endTime: string;
  slotDuration: number;
  maxPatients: number;
  createdByUserId: number;
};

export type UpdateCenterScheduleInput = {
  medicalCenterId: string;
  scheduleId: string;
  doctorUserId?: number;
  date?: string;
  startTime?: string;
  endTime?: string;
  slotDuration?: number;
  maxPatients?: number;
  isActive?: boolean;
  updatedByUserId: number;
};

type DoctorProfileRow = {
  id: number;
  user_id: number;
  specialization: string | null;
};

type CenterDoctorMembershipRow = {
  id: string;
  status: string;
};

type AvailabilityRow = {
  id: number;
  doctor_id: number;
  day_of_week: number | null;
  day: string | null;
  start_time: string;
  end_time: string;
  is_active: boolean | null;
};

type CenterScheduleRow = {
  id: number;
  medical_center_id: string;
  doctor_user_id: number;
  doctor_profile_id: number;
  date: string;
  start_time: string;
  end_time: string;
  room_number?: string | null;
  slot_duration: number;
  max_patients: number;
  patients_count?: number | null;
  is_active: boolean;
  source?: string | null;
  routine_id?: number | null;
  invalid_reason: string | null;
  invalidated_at: string | null;
  created_at: string;
  updated_at: string;
  clinic_name?: string | null;
  clinic_type?: string | null;
  clinic_location?: string | null;
  cover_image_url?: string | null;
  logo_url?: string | null;
  doctor_name?: string | null;
  doctor_email?: string | null;
  specialization?: string | null;
};

type QueueRow = {
  id: number;
  status: string;
};

type BookingCountRow = {
  count: number;
};

type RoutineRow = {
  id: number;
  doctor_id: number;
  clinic_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  room_number: string | null;
  slot_duration: number;
  max_patients: number;
  is_active: boolean;
};

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const doctorRoom = (doctorId: number | string) => `doctor_${doctorId}`;
const legacyDoctorRoom = (doctorId: number | string) => `doctor-${doctorId}`;

const createStatusError = (message: string, statusCode: number, details?: string[]) => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  if (details?.length) {
    error.details = details;
  }
  return error;
};

const emitScheduleUpdate = (payload: {
  doctorUserId: number;
  medicalCenterId: string;
  scheduleId?: number | null;
  type: string;
}) => {
  const eventPayload = {
    doctorId: payload.doctorUserId,
    medicalCenterId: payload.medicalCenterId,
    scheduleId: payload.scheduleId ?? null,
    type: payload.type,
    emittedAt: new Date().toISOString(),
  };

  io.to(doctorRoom(payload.doctorUserId)).emit("schedule:update", eventPayload);
  io.to(legacyDoctorRoom(payload.doctorUserId)).emit("schedule:update", eventPayload);
  io.to(`center_${payload.medicalCenterId}`).emit("schedule:update", eventPayload);
  emitClinicPublicScheduleUpdate({
    clinicId: payload.medicalCenterId,
    doctorId: payload.doctorUserId,
    scheduleId: payload.scheduleId ?? null,
    type: payload.type,
  });
};

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

const ensureValidTimeRange = (startTime: string, endTime: string) => {
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);

  if (startMinutes >= endMinutes) {
    throw createStatusError("start_time must be earlier than end_time", 400);
  }

  return { startMinutes, endMinutes };
};

const normalizeDate = (value: unknown) => String(value || "").trim();

const ensureFutureDate = (value: string) => {
  const normalized = normalizeDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw createStatusError("date must be in YYYY-MM-DD format", 400);
  }

  const scheduledAt = new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw createStatusError("Invalid schedule date", 400);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (scheduledAt.getTime() < today.getTime()) {
    throw createStatusError("Schedules can only be created for today or future dates", 400);
  }

  return normalized;
};

const getDateDayOfWeek = (value: string) => {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw createStatusError("Invalid schedule date", 400);
  }
  return date.getDay();
};

const getDoctorProfileByUserId = async (client: PoolClient, doctorUserId: number) => {
  const result = await client.query<DoctorProfileRow>(
    `
      SELECT id, user_id, specialization
      FROM doctors
      WHERE user_id = $1
      LIMIT 1
    `,
    [doctorUserId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Doctor profile not found", 404);
  }

  return result.rows[0];
};

const requireDoctorMembership = async (
  client: PoolClient,
  medicalCenterId: string,
  doctorUserId: number
) => {
  const result = await client.query<CenterDoctorMembershipRow>(
    `
      SELECT id, status
      FROM medical_center_doctors
      WHERE medical_center_id = $1
        AND doctor_id = $2
      LIMIT 1
    `,
    [medicalCenterId, doctorUserId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Doctor is not assigned to this medical center", 404);
  }

  if (String(result.rows[0].status).toUpperCase() !== "ACTIVE") {
    throw createStatusError("Doctor must be active in this medical center", 400);
  }

  return result.rows[0];
};

const requireMedicalCenter = async (client: PoolClient, medicalCenterId: string) => {
  const result = await client.query<{ id: string; name: string; type: string | null }>(
    `SELECT id, name, type FROM medical_centers WHERE id = $1 LIMIT 1`,
    [medicalCenterId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Medical center not found", 404);
  }

  return result.rows[0];
};

const loadActiveAvailabilityForDay = async (
  client: PoolClient,
  doctorProfileId: number,
  dayOfWeek: number
) => {
  const result = await client.query<AvailabilityRow>(
    `
      SELECT id, doctor_id, day_of_week, day, start_time, end_time, is_active
      FROM doctor_availability
      WHERE doctor_id = $1
        AND COALESCE(is_active, TRUE) = TRUE
        AND COALESCE(day_of_week, CASE day
          WHEN 'Sunday' THEN 0
          WHEN 'Monday' THEN 1
          WHEN 'Tuesday' THEN 2
          WHEN 'Wednesday' THEN 3
          WHEN 'Thursday' THEN 4
          WHEN 'Friday' THEN 5
          WHEN 'Saturday' THEN 6
          ELSE -1
        END) = $2
      ORDER BY start_time ASC
    `,
    [doctorProfileId, dayOfWeek]
  );

  return result.rows;
};

export const checkAvailability = async (input: {
  client?: PoolClient;
  doctorProfileId: number;
  date: string;
  startTime: string;
  endTime: string;
}) => {
  const db = input.client ?? pool;
  const dayOfWeek = getDateDayOfWeek(input.date);
  const availabilityRows = await db.query<AvailabilityRow>(
    `
      SELECT id, doctor_id, day_of_week, day, start_time, end_time, is_active
      FROM doctor_availability
      WHERE doctor_id = $1
        AND COALESCE(is_active, TRUE) = TRUE
        AND COALESCE(day_of_week, CASE day
          WHEN 'Sunday' THEN 0
          WHEN 'Monday' THEN 1
          WHEN 'Tuesday' THEN 2
          WHEN 'Wednesday' THEN 3
          WHEN 'Thursday' THEN 4
          WHEN 'Friday' THEN 5
          WHEN 'Saturday' THEN 6
          ELSE -1
        END) = $2
      ORDER BY start_time ASC
    `,
    [input.doctorProfileId, dayOfWeek]
  );

  const requestedStart = parseTimeToMinutes(input.startTime);
  const requestedEnd = parseTimeToMinutes(input.endTime);

  const matchingAvailability = availabilityRows.rows.find((availability) => {
    const availabilityStart = parseTimeToMinutes(availability.start_time);
    const availabilityEnd = parseTimeToMinutes(availability.end_time);
    return requestedStart >= availabilityStart && requestedEnd <= availabilityEnd;
  });

  const availabilityLabel = formatAvailabilityRangeList(availabilityRows.rows);
  const requestedRange = `${normalizeTime(input.startTime)}-${normalizeTime(input.endTime)}`;

  return {
    ok: Boolean(matchingAvailability),
    availability: matchingAvailability ?? null,
    message: matchingAvailability
      ? null
      : availabilityRows.rows.length === 0
        ? `${DAY_NAMES[dayOfWeek]} is not available for this doctor`
        : `${DAY_NAMES[dayOfWeek]} ${requestedRange} is outside doctor availability ${availabilityLabel}`,
  };
};

export const checkOverlap = async (input: {
  client?: PoolClient;
  doctorUserId: number;
  date: string;
  startTime: string;
  endTime: string;
  excludeScheduleId?: number;
}) => {
  const db = input.client ?? pool;
  const params: Array<string | number> = [
    input.doctorUserId,
    input.date,
    input.startTime,
    input.endTime,
  ];
  let excludeClause = "";

  if (typeof input.excludeScheduleId === "number") {
    params.push(input.excludeScheduleId);
    excludeClause = `AND s.id != $5`;
  }

  const result = await db.query<CenterScheduleRow>(
    `
      SELECT
        s.id,
        s.medical_center_id,
        s.doctor_user_id,
        s.doctor_profile_id,
        s.date,
        s.start_time,
        s.end_time,
        s.room_number,
        s.slot_duration,
        s.max_patients,
        s.is_active,
        s.source,
        s.routine_id,
        s.invalid_reason,
        s.invalidated_at,
        s.created_at,
        s.updated_at,
        mc.name AS clinic_name,
        mc.type AS clinic_type
      FROM medical_center_doctor_schedule s
      JOIN medical_centers mc ON mc.id = s.medical_center_id
      WHERE s.doctor_user_id = $1
        AND s.date = $2::date
        AND s.is_active = TRUE
        AND ($3::time < s.end_time AND $4::time > s.start_time)
        ${excludeClause}
      ORDER BY s.start_time ASC
      LIMIT 1
    `,
    params
  );

  return {
    ok: result.rows.length === 0,
    conflict: result.rows[0] ?? null,
  };
};

export const generateScheduleSlots = (input: {
  date: string;
  startTime: string;
  endTime: string;
  slotDuration: number;
  maxPatients?: number;
  occupiedTimes?: string[];
}) => {
  const { startMinutes, endMinutes } = ensureValidTimeRange(input.startTime, input.endTime);
  if (!Number.isInteger(input.slotDuration) || input.slotDuration <= 0) {
    throw createStatusError("slot_duration must be greater than 0", 400);
  }

  const occupied = new Set((input.occupiedTimes || []).map((value) => normalizeTime(value)));
  const maxPatients = Number.isFinite(Number(input.maxPatients)) ? Number(input.maxPatients) : null;
  const slots = [];

  for (let cursor = startMinutes; cursor + input.slotDuration <= endMinutes; cursor += input.slotDuration) {
    const hours = String(Math.floor(cursor / 60)).padStart(2, "0");
    const minutes = String(cursor % 60).padStart(2, "0");
    const time = `${hours}:${minutes}`;

    slots.push({
      time,
      available: !occupied.has(time),
      remainingCapacity: maxPatients,
    });
  }

  return slots;
};

const countBookingsForSchedule = async (
  client: PoolClient,
  scheduleId: number
) => {
  const result = await client.query<BookingCountRow>(
    `
      SELECT COUNT(*)::int AS count
      FROM bookings
      WHERE session_id = $1
        AND COALESCE(UPPER(status), '') NOT IN ('CANCELLED', 'MISSED')
    `,
    [scheduleId]
  );

  return Number(result.rows[0]?.count || 0);
};

const findActiveQueueForSchedule = async (
  client: PoolClient,
  medicalCenterId: string,
  scheduleId: number
) => {
  const result = await client.query<QueueRow>(
    `
      SELECT id, status
      FROM queues
      WHERE medical_center_id = $1
        AND schedule_id = $2
        AND status IN ('LIVE', 'PAUSED')
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [medicalCenterId, scheduleId]
  );

  return result.rows[0] ?? null;
};

const mapScheduleRow = (row: CenterScheduleRow) => ({
  id: row.id,
  medical_center_id: row.medical_center_id,
  doctor_id: row.doctor_user_id,
  doctor_profile_id: row.doctor_profile_id,
  date: row.date,
  start_time: normalizeTime(row.start_time),
  end_time: normalizeTime(row.end_time),
  room_number: row.room_number?.trim() ? row.room_number.trim() : null,
  slot_duration: row.slot_duration,
  max_patients: row.max_patients,
  is_active: row.is_active,
  source: String(row.source || "manual").toLowerCase() === "routine" ? "routine" : "manual",
  routine_id: row.routine_id ?? null,
  invalid_reason: row.invalid_reason,
  invalidated_at: row.invalidated_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
  clinic_name: row.clinic_name ?? null,
  clinic_type: row.clinic_type ?? null,
  doctor_name: row.doctor_name ?? null,
  doctor_email: row.doctor_email ?? null,
  specialization: row.specialization ?? null,
  slots: generateScheduleSlots({
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    slotDuration: row.slot_duration,
    maxPatients: row.max_patients,
  }),
});

export const listCenterSchedules = async (medicalCenterId: string, options?: { activeOnly?: boolean }) => {
  const params: Array<string | boolean> = [medicalCenterId];
  let activeClause = "";

  if (options?.activeOnly) {
    params.push(true);
    activeClause = `AND s.is_active = $2`;
  }

  const result = await pool.query<CenterScheduleRow>(
    `
      SELECT
        s.id,
        s.medical_center_id,
        s.doctor_user_id,
        s.doctor_profile_id,
        s.date,
        s.start_time,
        s.end_time,
        s.slot_duration,
        s.max_patients,
        s.is_active,
        s.invalid_reason,
        s.invalidated_at,
        s.created_at,
        s.updated_at,
        mc.name AS clinic_name,
        mc.type AS clinic_type,
        u.name AS doctor_name,
        u.email AS doctor_email,
        d.specialization
      FROM medical_center_doctor_schedule s
      JOIN medical_centers mc ON mc.id = s.medical_center_id
      JOIN users u ON u.id = s.doctor_user_id
      LEFT JOIN doctors d ON d.user_id = s.doctor_user_id
      WHERE s.medical_center_id = $1
        ${activeClause}
      ORDER BY s.date ASC, s.start_time ASC
    `,
    params
  );

  return result.rows.map(mapScheduleRow);
};

export const previewCenterSchedule = async (input: Omit<CreateCenterScheduleInput, "createdByUserId">) => {
  const client = await pool.connect();

  try {
    await requireMedicalCenter(client, input.medicalCenterId);
    await requireDoctorMembership(client, input.medicalCenterId, input.doctorUserId);
    const doctorProfile = await getDoctorProfileByUserId(client, input.doctorUserId);

    const date = ensureFutureDate(input.date);
    const startTime = normalizeTime(input.startTime);
    const endTime = normalizeTime(input.endTime);
    ensureValidTimeRange(startTime, endTime);

    const availabilityCheck = await checkAvailability({
      client,
      doctorProfileId: doctorProfile.id,
      date,
      startTime,
      endTime,
    });
    if (!availabilityCheck.ok) {
      throw createStatusError(availabilityCheck.message || "Requested schedule is outside availability", 400);
    }

    const overlapCheck = await checkOverlap({
      client,
      doctorUserId: input.doctorUserId,
      date,
      startTime,
      endTime,
    });
    if (!overlapCheck.ok) {
      throw createStatusError(
        `Doctor is already scheduled in ${overlapCheck.conflict?.clinic_name || "another clinic"}`,
        409
      );
    }

    return {
      ok: true,
      availability: availabilityCheck.availability
        ? {
            id: availabilityCheck.availability.id,
            day_of_week:
              availabilityCheck.availability.day_of_week ??
              DAY_NAMES.indexOf((availabilityCheck.availability.day || "Sunday") as (typeof DAY_NAMES)[number]),
            start_time: normalizeTime(availabilityCheck.availability.start_time),
            end_time: normalizeTime(availabilityCheck.availability.end_time),
          }
        : null,
      slots: generateScheduleSlots({
        date,
        startTime,
        endTime,
        slotDuration: input.slotDuration,
        maxPatients: input.maxPatients,
      }),
      warning: null,
    };
  } finally {
    client.release();
  }
};

export const createCenterSchedule = async (input: CreateCenterScheduleInput) => {
  const date = ensureFutureDate(input.date);
  const startTime = normalizeTime(input.startTime);
  const endTime = normalizeTime(input.endTime);
  ensureValidTimeRange(startTime, endTime);

  if (!Number.isInteger(input.slotDuration) || input.slotDuration <= 0) {
    throw createStatusError("slot_duration must be greater than 0", 400);
  }

  if (!Number.isInteger(input.maxPatients) || input.maxPatients <= 0) {
    throw createStatusError("max_patients must be greater than 0", 400);
  }

  const totalMinutes = parseTimeToMinutes(endTime) - parseTimeToMinutes(startTime);
  const generatedSlots = Math.floor(totalMinutes / input.slotDuration);
  if (generatedSlots <= 0) {
    throw createStatusError("Schedule must generate at least one slot", 400);
  }

  if (input.maxPatients > generatedSlots) {
    throw createStatusError("max_patients cannot exceed generated slot count", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await requireMedicalCenter(client, input.medicalCenterId);
    await requireDoctorMembership(client, input.medicalCenterId, input.doctorUserId);
    const doctorProfile = await getDoctorProfileByUserId(client, input.doctorUserId);

    const availabilityCheck = await checkAvailability({
      client,
      doctorProfileId: doctorProfile.id,
      date,
      startTime,
      endTime,
    });
    if (!availabilityCheck.ok) {
      throw createStatusError(availabilityCheck.message || "Requested schedule is outside availability", 400);
    }

    const overlapCheck = await checkOverlap({
      client,
      doctorUserId: input.doctorUserId,
      date,
      startTime,
      endTime,
    });
    if (!overlapCheck.ok) {
      throw createStatusError(
        `Doctor already scheduled in ${overlapCheck.conflict?.clinic_name || "another clinic"}`,
        409
      );
    }

    const result = await client.query<CenterScheduleRow>(
      `
        INSERT INTO medical_center_doctor_schedule (
          medical_center_id,
          doctor_user_id,
          doctor_profile_id,
          date,
          start_time,
          end_time,
          slot_duration,
          max_patients,
          is_active
        )
        VALUES ($1, $2, $3, $4::date, $5::time, $6::time, $7, $8, TRUE)
        RETURNING
          id,
          medical_center_id,
          doctor_user_id,
          doctor_profile_id,
          date,
          start_time,
          end_time,
          slot_duration,
          max_patients,
          is_active,
          source,
          routine_id,
          invalid_reason,
          invalidated_at,
          created_at,
          updated_at
      `,
      [
        input.medicalCenterId,
        input.doctorUserId,
        doctorProfile.id,
        date,
        startTime,
        endTime,
        input.slotDuration,
        input.maxPatients,
      ]
    );

    await client.query("COMMIT");

    emitScheduleUpdate({
      doctorUserId: input.doctorUserId,
      medicalCenterId: input.medicalCenterId,
      scheduleId: result.rows[0]?.id ?? null,
      type: "session:created",
    });

    return {
      message: "Doctor schedule created successfully",
      schedule: mapScheduleRow(result.rows[0]),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const getCenterScheduleById = async (
  client: PoolClient,
  medicalCenterId: string,
  scheduleId: string
) => {
  const result = await client.query<CenterScheduleRow>(
    `
      SELECT
        s.id,
        s.medical_center_id,
        s.doctor_user_id,
        s.doctor_profile_id,
        s.date,
        s.start_time,
        s.end_time,
        s.slot_duration,
        s.max_patients,
        s.is_active,
        s.source,
        s.routine_id,
        s.invalid_reason,
        s.invalidated_at,
        s.created_at,
        s.updated_at
      FROM medical_center_doctor_schedule s
      WHERE s.id = $1::int
        AND s.medical_center_id = $2
      LIMIT 1
    `,
    [scheduleId, medicalCenterId]
  );

  return result.rows[0] ?? null;
};

export const updateCenterSchedule = async (input: UpdateCenterScheduleInput) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await getCenterScheduleById(client, input.medicalCenterId, input.scheduleId);
    if (!existing) {
      throw createStatusError("Schedule not found", 404);
    }

    const nextDoctorUserId = input.doctorUserId ?? existing.doctor_user_id;
    const nextDate = ensureFutureDate(input.date ?? existing.date);
    const nextStartTime = normalizeTime(input.startTime ?? existing.start_time);
    const nextEndTime = normalizeTime(input.endTime ?? existing.end_time);
    const nextSlotDuration = input.slotDuration ?? existing.slot_duration;
    const nextMaxPatients = input.maxPatients ?? existing.max_patients;
    const nextIsActive = typeof input.isActive === "boolean" ? input.isActive : existing.is_active;

    ensureValidTimeRange(nextStartTime, nextEndTime);

    if (!Number.isInteger(nextSlotDuration) || nextSlotDuration <= 0) {
      throw createStatusError("slot_duration must be greater than 0", 400);
    }

    if (!Number.isInteger(nextMaxPatients) || nextMaxPatients <= 0) {
      throw createStatusError("max_patients must be greater than 0", 400);
    }

    const totalMinutes = parseTimeToMinutes(nextEndTime) - parseTimeToMinutes(nextStartTime);
    const slotCount = Math.floor(totalMinutes / nextSlotDuration);
    if (slotCount <= 0) {
      throw createStatusError("Schedule must generate at least one slot", 400);
    }

    if (nextMaxPatients > slotCount) {
      throw createStatusError("max_patients cannot exceed generated slot count", 400);
    }

    const bookingCount = await countBookingsForSchedule(
      client,
      existing.id
    );

    const activeQueue = await findActiveQueueForSchedule(
      client,
      input.medicalCenterId,
      existing.id
    );

    const scheduleShapeChanged =
      nextDoctorUserId !== existing.doctor_user_id ||
      nextDate !== existing.date ||
      nextStartTime !== normalizeTime(existing.start_time) ||
      nextEndTime !== normalizeTime(existing.end_time) ||
      nextSlotDuration !== existing.slot_duration ||
      nextMaxPatients !== existing.max_patients;

    if (scheduleShapeChanged && bookingCount > 0) {
      throw createStatusError("Cannot edit a schedule that already has appointments", 400);
    }

    if (scheduleShapeChanged && activeQueue) {
      throw createStatusError("Cannot edit a schedule after the queue has started", 400);
    }

    await requireDoctorMembership(client, input.medicalCenterId, nextDoctorUserId);
    const doctorProfile = await getDoctorProfileByUserId(client, nextDoctorUserId);

    const availabilityCheck = await checkAvailability({
      client,
      doctorProfileId: doctorProfile.id,
      date: nextDate,
      startTime: nextStartTime,
      endTime: nextEndTime,
    });
    if (!availabilityCheck.ok) {
      throw createStatusError(availabilityCheck.message || "Requested schedule is outside availability", 400);
    }

    const overlapCheck = await checkOverlap({
      client,
      doctorUserId: nextDoctorUserId,
      date: nextDate,
      startTime: nextStartTime,
      endTime: nextEndTime,
      excludeScheduleId: Number(existing.id),
    });
    if (!overlapCheck.ok) {
      throw createStatusError(
        `Doctor already scheduled in ${overlapCheck.conflict?.clinic_name || "another clinic"}`,
        409
      );
    }

    const result = await client.query<CenterScheduleRow>(
      `
        UPDATE medical_center_doctor_schedule
        SET doctor_user_id = $1,
            doctor_profile_id = $2,
            date = $3::date,
            start_time = $4::time,
            end_time = $5::time,
            slot_duration = $6,
            max_patients = $7,
            is_active = $8,
            invalid_reason = NULL,
            invalidated_at = NULL,
            updated_at = NOW()
        WHERE id = $9::int
          AND medical_center_id = $10
        RETURNING
          id,
          medical_center_id,
          doctor_user_id,
          doctor_profile_id,
          date,
          start_time,
          end_time,
          slot_duration,
          max_patients,
          is_active,
          source,
          routine_id,
          invalid_reason,
          invalidated_at,
          created_at,
          updated_at
      `,
      [
        nextDoctorUserId,
        doctorProfile.id,
        nextDate,
        nextStartTime,
        nextEndTime,
        nextSlotDuration,
        nextMaxPatients,
        nextIsActive,
        existing.id,
        input.medicalCenterId,
      ]
    );

    await client.query("COMMIT");

    emitScheduleUpdate({
      doctorUserId: nextDoctorUserId,
      medicalCenterId: input.medicalCenterId,
      scheduleId: result.rows[0]?.id ?? null,
      type: "session:updated",
    });

    if (nextDoctorUserId !== existing.doctor_user_id) {
      emitScheduleUpdate({
        doctorUserId: existing.doctor_user_id,
        medicalCenterId: input.medicalCenterId,
        scheduleId: existing.id,
        type: "session:updated",
      });
    }

    return {
      message: "Doctor schedule updated successfully",
      schedule: mapScheduleRow(result.rows[0]),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const disableCenterSchedule = async (input: {
  medicalCenterId: string;
  scheduleId: string;
  doctorUserId?: number;
  disabledByUserId: number;
}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await getCenterScheduleById(client, input.medicalCenterId, input.scheduleId);
    if (!existing) {
      throw createStatusError("Schedule not found", 404);
    }

    if (
      typeof input.doctorUserId === "number" &&
      Number.isInteger(input.doctorUserId) &&
      existing.doctor_user_id !== input.doctorUserId
    ) {
      throw createStatusError("Schedule not found for this doctor", 404);
    }

    const bookingCount = await countBookingsForSchedule(
      client,
      existing.id
    );

    const activeQueue = await findActiveQueueForSchedule(
      client,
      input.medicalCenterId,
      existing.id
    );

    if (bookingCount > 0 || activeQueue) {
      throw createStatusError(
        "Schedule cannot be disabled after appointments exist or queue already started",
        400
      );
    }

    const result = await client.query<CenterScheduleRow>(
      `
        UPDATE medical_center_doctor_schedule
        SET is_active = FALSE,
            updated_at = NOW()
        WHERE id = $1::int
          AND medical_center_id = $2
        RETURNING
          id,
          medical_center_id,
          doctor_user_id,
          doctor_profile_id,
          date,
          start_time,
          end_time,
          slot_duration,
          max_patients,
          is_active,
          source,
          routine_id,
          invalid_reason,
          invalidated_at,
          created_at,
          updated_at
      `,
      [input.scheduleId, input.medicalCenterId]
    );

    await client.query("COMMIT");

    emitScheduleUpdate({
      doctorUserId: existing.doctor_user_id,
      medicalCenterId: input.medicalCenterId,
      scheduleId: result.rows[0]?.id ?? null,
      type: "session:disabled",
    });

    return {
      message: "Doctor schedule disabled successfully",
      schedule: mapScheduleRow(result.rows[0]),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getDoctorScheduleOverview = async (doctorUserId: number, options?: { from?: string; to?: string }) => {
  const client = await pool.connect();

  try {
    const doctorProfile = await getDoctorProfileByUserId(client, doctorUserId);
    const from = options?.from ? ensureFutureDate(options.from) : normalizeDate(getTodayDateKey());
    const to = options?.to ? ensureFutureDate(options.to) : from;

    const availabilityResult = await client.query<AvailabilityRow>(
      `
        SELECT id, doctor_id, day_of_week, day, start_time, end_time, is_active
        FROM doctor_availability
        WHERE doctor_id = $1
          AND COALESCE(is_active, TRUE) = TRUE
        ORDER BY COALESCE(day_of_week, 7), start_time ASC
      `,
      [doctorProfile.id]
    );

    const scheduleResult = await client.query<CenterScheduleRow>(
      `
        SELECT
          s.id,
          s.medical_center_id,
          s.doctor_user_id,
          s.doctor_profile_id,
          s.date,
          s.start_time,
          s.end_time,
          s.slot_duration,
          s.max_patients,
          COALESCE(bookings.patients_count, 0) AS patients_count,
          s.is_active,
          s.invalid_reason,
          s.invalidated_at,
          s.created_at,
          s.updated_at,
          mc.name AS clinic_name,
          mc.type AS clinic_type,
          COALESCE(mc.address, mc.city) AS clinic_location,
          mc.cover_image_url,
          mc.logo_url
        FROM medical_center_doctor_schedule s
        JOIN medical_centers mc ON mc.id = s.medical_center_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS patients_count
          FROM bookings b
          WHERE b.session_id = s.id
            AND COALESCE(UPPER(b.status), '') NOT IN ('CANCELLED', 'MISSED')
        ) bookings ON TRUE
        WHERE s.doctor_user_id = $1
          AND s.date BETWEEN $2::date AND $3::date
        ORDER BY s.date ASC, s.start_time ASC
      `,
      [doctorUserId, from, to]
    );

    const overview: ScheduleOverviewItem[] = [];
    const startDate = new Date(`${from}T00:00:00`);
    const endDate = new Date(`${to}T00:00:00`);

    for (
      let cursor = new Date(startDate.getTime());
      cursor.getTime() <= endDate.getTime();
      cursor.setDate(cursor.getDate() + 1)
    ) {
      const dateKey = formatDateKeyInAppTimeZone(cursor);
      const dayOfWeek = cursor.getDay();

      availabilityResult.rows
        .filter((availability) => {
          const availabilityDay =
            availability.day_of_week ??
            DAY_NAMES.indexOf((availability.day || "Sunday") as (typeof DAY_NAMES)[number]);
          return availabilityDay === dayOfWeek;
        })
        .forEach((availability) => {
          overview.push({
            type: "AVAILABLE",
            date: dateKey,
            start: normalizeTime(availability.start_time),
            end: normalizeTime(availability.end_time),
          });
        });

      scheduleResult.rows
        .filter((schedule) => schedule.date === dateKey)
        .forEach((schedule) => {
          overview.push({
            type: schedule.is_active && !schedule.invalid_reason ? "CLINIC" : "BLOCKED",
            date: dateKey,
            start: normalizeTime(schedule.start_time),
            end: normalizeTime(schedule.end_time),
            clinicName: schedule.clinic_name ?? null,
            clinicId: schedule.medical_center_id ?? null,
            clinicType: schedule.clinic_type ?? null,
            location: schedule.clinic_location ?? null,
            cover_image_url: schedule.cover_image_url ?? null,
            logo_url: schedule.logo_url ?? null,
            scheduleId: schedule.id,
            patientsCount: Number(schedule.patients_count || 0),
            maxPatients:
              schedule.max_patients === null || schedule.max_patients === undefined
                ? null
                : Number(schedule.max_patients),
            slotDuration:
              schedule.slot_duration === null || schedule.slot_duration === undefined
                ? null
                : Number(schedule.slot_duration),
            reason: schedule.invalid_reason,
          });
        });
    }

    overview.sort((left, right) => {
      if (left.date !== right.date) {
        return left.date.localeCompare(right.date);
      }
      return left.start.localeCompare(right.start);
    });

    return overview;
  } finally {
    client.release();
  }
};

export const markInvalidClinicSchedulesForDoctor = async (input: {
  doctorProfileId: number;
  fromDate?: string;
}) => {
  const client = await pool.connect();
  const fromDate = input.fromDate ? ensureFutureDate(input.fromDate) : getTodayDateKey();

  try {
    await client.query("BEGIN");

    const schedulesResult = await client.query<CenterScheduleRow>(
      `
        SELECT
          id,
          medical_center_id,
          doctor_user_id,
          doctor_profile_id,
          date::text AS date,
          start_time,
          end_time,
          slot_duration,
          max_patients,
          is_active,
          invalid_reason,
          invalidated_at,
          created_at,
          updated_at
        FROM medical_center_doctor_schedule
        WHERE doctor_profile_id = $1
          AND date >= $2::date
          AND is_active = TRUE
      `,
      [input.doctorProfileId, fromDate]
    );

    const invalidScheduleIds: number[] = [];
    const invalidatedSchedules: Array<{ doctorUserId: number; medicalCenterId: string; scheduleId: number }> = [];

    for (const schedule of schedulesResult.rows) {
      const availabilityCheck = await checkAvailability({
        client,
        doctorProfileId: input.doctorProfileId,
        date: schedule.date,
        startTime: normalizeTime(schedule.start_time),
        endTime: normalizeTime(schedule.end_time),
      });

      if (!availabilityCheck.ok) {
        invalidScheduleIds.push(schedule.id);
        invalidatedSchedules.push({
          doctorUserId: schedule.doctor_user_id,
          medicalCenterId: schedule.medical_center_id,
          scheduleId: schedule.id,
        });
      }
    }

    if (invalidScheduleIds.length > 0) {
      await client.query(
        `
          UPDATE medical_center_doctor_schedule
          SET invalid_reason = 'Doctor availability changed',
              invalidated_at = NOW(),
              updated_at = NOW()
          WHERE id = ANY($1::int[])
        `,
        [invalidScheduleIds]
      );
    }

    await client.query("COMMIT");

    invalidatedSchedules.forEach((schedule) => {
      emitScheduleUpdate({
        doctorUserId: schedule.doctorUserId,
        medicalCenterId: schedule.medicalCenterId,
        scheduleId: schedule.scheduleId,
        type: "session:invalidated",
      });
    });

    return invalidScheduleIds;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const APP_TZ = env.appTz;

const formatDateKeyInAppTimeZone = (value: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);

  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
};

const getTodayDateKey = () => formatDateKeyInAppTimeZone(new Date());

const getDateKeysForDayOfWeek = (dayOfWeek: number, weeks: number) => {
  const today = new Date(`${getTodayDateKey()}T00:00:00`);
  const result: string[] = [];
  const totalDays = weeks * 7;

  for (let offset = 0; offset < totalDays; offset += 1) {
    const current = new Date(today.getTime());
    current.setDate(today.getDate() + offset);
    if (current.getDay() !== dayOfWeek) {
      continue;
    }
    result.push(formatDateKeyInAppTimeZone(current));
  }

  return result;
};

const buildDayName = (dayOfWeek: number) => DAY_NAMES[dayOfWeek] || "Sunday";

const formatAvailabilityRangeList = (rows: Array<{ start_time: string; end_time: string }>) =>
  rows
    .map((row) => `${normalizeTime(row.start_time)}-${normalizeTime(row.end_time)}`)
    .join(", ");

const isTimeRangeInsideAvailability = (
  availabilityRows: Array<{ start_time: string; end_time: string }>,
  startTime: string,
  endTime: string
) => {
  const requestedStart = parseTimeToMinutes(startTime);
  const requestedEnd = parseTimeToMinutes(endTime);

  return availabilityRows.some((row) => {
    const availabilityStart = parseTimeToMinutes(row.start_time);
    const availabilityEnd = parseTimeToMinutes(row.end_time);
    return requestedStart >= availabilityStart && requestedEnd <= availabilityEnd;
  });
};

const listActiveAvailabilityForDate = async (
  client: PoolClient,
  doctorProfileId: number,
  date: string
) => {
  const dayOfWeek = getDateDayOfWeek(date);
  const rows = await loadActiveAvailabilityForDay(client, doctorProfileId, dayOfWeek);

  return rows.map((row) => ({
    id: row.id,
    day: row.day ?? buildDayName(dayOfWeek),
    day_of_week: row.day_of_week ?? dayOfWeek,
    start_time: normalizeTime(row.start_time),
    end_time: normalizeTime(row.end_time),
    is_active: row.is_active ?? true,
  }));
};

export const listCenterSchedulesForDoctor = async (
  medicalCenterId: string,
  doctorUserId: number,
  options?: { activeOnly?: boolean }
) => {
  const params: Array<string | number | boolean> = [medicalCenterId, doctorUserId];
  let activeClause = "";

  if (options?.activeOnly) {
    params.push(true);
    activeClause = `AND s.is_active = $3`;
  }

  const result = await pool.query<CenterScheduleRow>(
    `
      SELECT
        s.id,
        s.medical_center_id,
        s.doctor_user_id,
        s.doctor_profile_id,
        s.date,
        s.start_time,
        s.end_time,
        s.slot_duration,
        s.max_patients,
        s.is_active,
        s.source,
        s.routine_id,
        s.invalid_reason,
        s.invalidated_at,
        s.created_at,
        s.updated_at,
        mc.name AS clinic_name,
        mc.type AS clinic_type,
        u.name AS doctor_name,
        u.email AS doctor_email,
        d.specialization
      FROM medical_center_doctor_schedule s
      JOIN medical_centers mc ON mc.id = s.medical_center_id
      JOIN users u ON u.id = s.doctor_user_id
      LEFT JOIN doctors d ON d.user_id = s.doctor_user_id
      WHERE s.medical_center_id = $1
        AND s.doctor_user_id = $2
        ${activeClause}
      ORDER BY s.date ASC, s.start_time ASC
    `,
    params
  );

  return result.rows.map(mapScheduleRow);
};

export const listCenterDoctorRoutines = async (medicalCenterId: string, doctorUserId: number) => {
  const client = await pool.connect();

  try {
    await requireMedicalCenter(client, medicalCenterId);
    await requireDoctorMembership(client, medicalCenterId, doctorUserId);
    const doctorProfile = await getDoctorProfileByUserId(client, doctorUserId);

    const result = await client.query<RoutineRow>(
      `
        SELECT id, doctor_id, clinic_id, day_of_week, start_time, end_time, room_number, slot_duration, max_patients, is_active
        FROM doctor_routines
        WHERE doctor_id = $1
          AND clinic_id = $2
          AND COALESCE(is_active, TRUE) = TRUE
        ORDER BY day_of_week ASC, start_time ASC
      `,
      [doctorProfile.id, medicalCenterId]
    );

    const grouped = new Map<number, Array<{
      id: string;
      clinicId: string;
      clinicName: string;
      startTime: string;
      endTime: string;
      roomNumber: string | null;
      slotDuration: number;
      maxPatients: number;
    }>>();

    result.rows.forEach((row) => {
      if (!grouped.has(row.day_of_week)) {
        grouped.set(row.day_of_week, []);
      }
      grouped.get(row.day_of_week)!.push({
        id: String(row.id),
        clinicId: medicalCenterId,
        clinicName: "Medical Center",
        startTime: normalizeTime(row.start_time),
        endTime: normalizeTime(row.end_time),
        roomNumber: row.room_number?.trim() ? row.room_number.trim() : null,
        slotDuration: row.slot_duration,
        maxPatients: row.max_patients,
      });
    });

    return Array.from(grouped.entries()).map(([dayKey, routines]) => ({
      day: buildDayName(dayKey),
      dayKey,
      routines,
    }));
  } finally {
    client.release();
  }
};

export const listDoctorRoutines = async (doctorUserId: number) => {
  const client = await pool.connect();

  try {
    const doctorProfile = await getDoctorProfileByUserId(client, doctorUserId);

    const result = await client.query<
      RoutineRow & {
        clinic_name: string | null;
        clinic_location: string | null;
        cover_image_url: string | null;
        logo_url: string | null;
      }
    >(
      `
        SELECT
          dr.id,
          dr.doctor_id,
          dr.clinic_id,
          dr.day_of_week,
          dr.start_time,
          dr.end_time,
          dr.room_number,
          dr.slot_duration,
          dr.max_patients,
          dr.is_active,
          mc.name AS clinic_name,
          COALESCE(mc.address, mc.city) AS clinic_location,
          mc.cover_image_url,
          mc.logo_url
        FROM doctor_routines dr
        JOIN medical_centers mc ON mc.id = dr.clinic_id
        WHERE dr.doctor_id = $1
          AND COALESCE(dr.is_active, TRUE) = TRUE
        ORDER BY dr.day_of_week ASC, dr.start_time ASC
      `,
      [doctorProfile.id]
    );

    const grouped = new Map<number, Array<{
      id: string;
      clinicId: string;
      clinicName: string;
      location: string | null;
      cover_image_url: string | null;
      logo_url: string | null;
      startTime: string;
      endTime: string;
      roomNumber: string | null;
      slotDuration: number;
      maxPatients: number;
    }>>();

    result.rows.forEach((row) => {
      if (!grouped.has(row.day_of_week)) {
        grouped.set(row.day_of_week, []);
      }

      grouped.get(row.day_of_week)!.push({
        id: String(row.id),
        clinicId: row.clinic_id,
        clinicName: row.clinic_name?.trim() || "Clinic",
        location: row.clinic_location?.trim() || null,
        cover_image_url: row.cover_image_url ?? null,
        logo_url: row.logo_url ?? null,
        startTime: normalizeTime(row.start_time),
        endTime: normalizeTime(row.end_time),
        roomNumber: row.room_number?.trim() ? row.room_number.trim() : null,
        slotDuration: row.slot_duration,
        maxPatients: row.max_patients,
      });
    });

    return Array.from(grouped.entries()).map(([dayKey, routines]) => ({
      day: buildDayName(dayKey),
      dayKey,
      routines,
    }));
  } finally {
    client.release();
  }
};

export const getCenterDoctorAvailabilityForDate = async (
  medicalCenterId: string,
  doctorUserId: number,
  date: string
) => {
  const client = await pool.connect();

  try {
    await requireMedicalCenter(client, medicalCenterId);
    await requireDoctorMembership(client, medicalCenterId, doctorUserId);
    const doctorProfile = await getDoctorProfileByUserId(client, doctorUserId);
    const normalizedDate = ensureFutureDate(date);
    return listActiveAvailabilityForDate(client, doctorProfile.id, normalizedDate);
  } finally {
    client.release();
  }
};

export const getCenterDoctorAvailabilityState = async (
  medicalCenterId: string,
  doctorUserId: number
) => {
  const client = await pool.connect();

  try {
    await requireMedicalCenter(client, medicalCenterId);
    await requireDoctorMembership(client, medicalCenterId, doctorUserId);
  } finally {
    client.release();
  }

  return getDoctorAvailabilityState(doctorUserId);
};

export const saveCenterDoctorRoutine = async (input: {
  medicalCenterId: string;
  doctorUserId: number;
  weeks?: number;
  slotDuration: number;
  maxPatients: number;
  routine: Array<{
    dayOfWeek: number;
    shifts: Array<{ start: string; end: string; roomNumber?: string | null }>;
  }>;
}) => {
  const weeks = Number.isInteger(input.weeks) && Number(input.weeks) > 0 ? Number(input.weeks) : 4;
  const slotDuration = Number(input.slotDuration);
  const maxPatients = Number(input.maxPatients);

  if (!Number.isInteger(slotDuration) || slotDuration <= 0) {
    throw createStatusError("slot_duration must be greater than 0", 400);
  }

  if (!Number.isInteger(maxPatients) || maxPatients <= 0) {
    throw createStatusError("max_patients must be greater than 0", 400);
  }

  const mergedRoutineByDay = new Map<number, Array<{ start: string; end: string; roomNumber: string }>>();
  (Array.isArray(input.routine) ? input.routine : [])
    .filter((day) => Number.isInteger(day?.dayOfWeek) && day.dayOfWeek >= 0 && day.dayOfWeek <= 6)
    .forEach((day) => {
      const dayOfWeek = Number(day.dayOfWeek);
      const existing = mergedRoutineByDay.get(dayOfWeek) ?? [];
      const normalizedShifts = (Array.isArray(day.shifts) ? day.shifts : []).map((shift) => ({
        start: normalizeTime(shift.start),
        end: normalizeTime(shift.end),
        roomNumber: String(shift.roomNumber || "").trim(),
      }));
      mergedRoutineByDay.set(dayOfWeek, [...existing, ...normalizedShifts]);
    });

  const normalizedRoutine = Array.from(mergedRoutineByDay.entries())
    .map(([dayOfWeek, shifts]) => ({
      dayOfWeek,
      shifts,
    }))
    .filter((day) => day.shifts.length > 0);

  if (normalizedRoutine.length === 0) {
    throw createStatusError("At least one routine day with shifts is required", 400);
  }

  normalizedRoutine.forEach((day) => {
    const sortedShifts = day.shifts
      .map((shift) => {
        if (!shift.roomNumber) {
          throw createStatusError("room_number is required for routine shifts", 400);
        }
        const { startMinutes, endMinutes } = ensureValidTimeRange(shift.start, shift.end);
        const slotCount = Math.floor((endMinutes - startMinutes) / slotDuration);
        if (slotCount <= 0) {
          throw createStatusError("Routine shift is too short for the selected slot duration", 400);
        }
        if (maxPatients > slotCount) {
          throw createStatusError("max_patients cannot exceed generated slot count", 400);
        }
        return { ...shift, startMinutes, endMinutes };
      })
      .sort((left, right) => left.startMinutes - right.startMinutes);

    for (let index = 0; index < sortedShifts.length - 1; index += 1) {
      if (sortedShifts[index].endMinutes > sortedShifts[index + 1].startMinutes) {
        throw createStatusError(`Routine shifts overlap on ${buildDayName(day.dayOfWeek)}`, 400);
      }
    }
  });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await requireMedicalCenter(client, input.medicalCenterId);
    await requireDoctorMembership(client, input.medicalCenterId, input.doctorUserId);
    const doctorProfile = await getDoctorProfileByUserId(client, input.doctorUserId);

    const availabilityValidationErrors: string[] = [];

    for (const day of normalizedRoutine) {
      const availabilityRows = await loadActiveAvailabilityForDay(client, doctorProfile.id, day.dayOfWeek);
      const availabilityLabel = formatAvailabilityRangeList(availabilityRows);

      if (availabilityRows.length === 0) {
        availabilityValidationErrors.push(
          `${buildDayName(day.dayOfWeek)} is not available for this doctor`
        );
        continue;
      }

      for (const shift of day.shifts) {
        if (!isTimeRangeInsideAvailability(availabilityRows, shift.start, shift.end)) {
          availabilityValidationErrors.push(
            `${buildDayName(day.dayOfWeek)} ${shift.start}-${shift.end} is outside doctor availability ${availabilityLabel}`
          );
        }
      }
    }

    if (availabilityValidationErrors.length > 0) {
      throw createStatusError(
        "Schedule is outside doctor availability",
        400,
        availabilityValidationErrors
      );
    }

    const existingRoutineSessions = await client.query<CenterScheduleRow>(
      `
        SELECT
          id,
          medical_center_id,
          doctor_user_id,
          doctor_profile_id,
          date,
          start_time,
          end_time,
          room_number,
          slot_duration,
          max_patients,
          is_active,
          source,
          routine_id,
          invalid_reason,
          invalidated_at,
          created_at,
          updated_at
        FROM medical_center_doctor_schedule
        WHERE medical_center_id = $1
          AND doctor_user_id = $2
          AND date >= $3::date
          AND source = 'routine'
      `,
      [input.medicalCenterId, input.doctorUserId, getTodayDateKey()]
    );

    await client.query(
      `
        DELETE FROM doctor_routines
        WHERE doctor_id = $1
          AND clinic_id = $2
      `,
      [doctorProfile.id, input.medicalCenterId]
    );

    const routineByKey = new Map<string, number>();

    for (const day of normalizedRoutine) {
      for (const shift of day.shifts) {
        const inserted = await client.query<{ id: number }>(
          `
            INSERT INTO doctor_routines (
              doctor_id,
              clinic_id,
              day_of_week,
              start_time,
              end_time,
              room_number,
              slot_duration,
              max_patients,
              is_active
            )
            VALUES ($1, $2, $3, $4::time, $5::time, $6, $7, $8, TRUE)
            RETURNING id
          `,
          [
            doctorProfile.id,
            input.medicalCenterId,
            day.dayOfWeek,
            shift.start,
            shift.end,
            shift.roomNumber,
            slotDuration,
            maxPatients,
          ]
        );

        routineByKey.set(`${day.dayOfWeek}|${shift.start}|${shift.end}`, inserted.rows[0].id);
      }
    }

    const targetKeys = new Set<string>();
    const retainedScheduleIds = new Set<number>();
    const createdSchedules: ReturnType<typeof mapScheduleRow>[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const day of normalizedRoutine) {
      const dates = getDateKeysForDayOfWeek(day.dayOfWeek, weeks);

      for (const date of dates) {
        for (const shift of day.shifts) {
          const key = `${date}|${shift.start}|${shift.end}`;
          targetKeys.add(key);

          const availabilityCheck = await checkAvailability({
            client,
            doctorProfileId: doctorProfile.id,
            date,
            startTime: shift.start,
            endTime: shift.end,
          });

          if (!availabilityCheck.ok) {
            skipped += 1;
            continue;
          }

          const existingResult = await client.query<CenterScheduleRow>(
            `
      SELECT
        s.id,
        s.medical_center_id,
        s.doctor_user_id,
        s.doctor_profile_id,
        s.date,
        s.start_time,
        s.end_time,
        s.room_number,
        s.slot_duration,
        s.max_patients,
                s.is_active,
                s.source,
                s.routine_id,
                s.invalid_reason,
                s.invalidated_at,
                s.created_at,
                s.updated_at,
                mc.name AS clinic_name,
                mc.type AS clinic_type,
                u.name AS doctor_name,
                u.email AS doctor_email,
                d.specialization
              FROM medical_center_doctor_schedule s
              JOIN medical_centers mc ON mc.id = s.medical_center_id
              JOIN users u ON u.id = s.doctor_user_id
              LEFT JOIN doctors d ON d.user_id = s.doctor_user_id
              WHERE s.medical_center_id = $1
                AND s.doctor_user_id = $2
                AND s.date = $3::date
                AND s.start_time = $4::time
              ORDER BY
                CASE WHEN s.end_time = $5::time THEN 0 ELSE 1 END,
                CASE WHEN LOWER(COALESCE(s.source::text, 'manual')) = 'manual' THEN 0 ELSE 1 END,
                s.created_at DESC
              LIMIT 1
            `,
            [input.medicalCenterId, input.doctorUserId, date, shift.start, shift.end]
          );

          const routineId = routineByKey.get(`${day.dayOfWeek}|${shift.start}|${shift.end}`) ?? null;

          if (existingResult.rows.length === 0) {
            const insertedSchedule = await client.query<CenterScheduleRow>(
              `
                INSERT INTO medical_center_doctor_schedule (
                  medical_center_id,
                  doctor_user_id,
                  doctor_profile_id,
                  date,
                  start_time,
                  end_time,
                  room_number,
                  slot_duration,
                  max_patients,
                  routine_id,
                  source,
                  is_active
                )
                VALUES ($1, $2, $3, $4::date, $5::time, $6::time, $7, $8, $9, $10, 'routine', TRUE)
                RETURNING
                  id,
                  medical_center_id,
                  doctor_user_id,
                  doctor_profile_id,
                  date,
                  start_time,
                  end_time,
                  room_number,
                  slot_duration,
                  max_patients,
                  is_active,
                  source,
                  routine_id,
                  invalid_reason,
                  invalidated_at,
                  created_at,
                  updated_at
              `,
              [
                input.medicalCenterId,
                input.doctorUserId,
                doctorProfile.id,
                date,
                shift.start,
                shift.end,
                shift.roomNumber,
                slotDuration,
                maxPatients,
                routineId,
              ]
            );
            created += 1;
            createdSchedules.push(mapScheduleRow(insertedSchedule.rows[0]));
            continue;
          }

          const existing = existingResult.rows[0];
          const existingSource = String(existing.source || "manual").toLowerCase();

          if (existingSource === "manual") {
            retainedScheduleIds.add(existing.id);
            skipped += 1;
            continue;
          }

          const bookingCount = await countBookingsForSchedule(
            client,
            existing.id
          );
          const activeQueue = await findActiveQueueForSchedule(
            client,
            input.medicalCenterId,
            existing.id
          );

          const shapeChanged =
            normalizeTime(existing.start_time) !== shift.start ||
            normalizeTime(existing.end_time) !== shift.end ||
            (existing.room_number?.trim() || "") !== shift.roomNumber ||
            existing.slot_duration !== slotDuration ||
            existing.max_patients !== maxPatients ||
            existing.is_active !== true ||
            existingSource !== "routine" ||
            existing.routine_id !== routineId;

          if (shapeChanged && (bookingCount > 0 || activeQueue)) {
            skipped += 1;
            continue;
          }

          if (!shapeChanged) {
            retainedScheduleIds.add(existing.id);
            createdSchedules.push(mapScheduleRow(existing));
            continue;
          }

          const updatedSchedule = await client.query<CenterScheduleRow>(
            `
              UPDATE medical_center_doctor_schedule
              SET doctor_profile_id = $1,
                  end_time = $2::time,
                  room_number = $3,
                  slot_duration = $4,
                  max_patients = $5,
                  routine_id = $6,
                  source = 'routine',
                  is_active = TRUE,
                  invalid_reason = NULL,
                  invalidated_at = NULL,
                  updated_at = NOW()
              WHERE id = $7
              RETURNING
                id,
                medical_center_id,
                doctor_user_id,
                doctor_profile_id,
                date,
                start_time,
                end_time,
                room_number,
                slot_duration,
                max_patients,
                is_active,
                source,
                routine_id,
                invalid_reason,
                invalidated_at,
                created_at,
                updated_at
            `,
            [doctorProfile.id, shift.end, shift.roomNumber, slotDuration, maxPatients, routineId, existing.id]
          );

          retainedScheduleIds.add(existing.id);
          updated += 1;
          createdSchedules.push(mapScheduleRow(updatedSchedule.rows[0]));
        }
      }
    }

    let disabled = 0;

    for (const existing of existingRoutineSessions.rows) {
      if (retainedScheduleIds.has(existing.id)) {
        continue;
      }

      const existingKey = `${existing.date}|${normalizeTime(existing.start_time)}|${normalizeTime(existing.end_time)}`;
      if (targetKeys.has(existingKey)) {
        continue;
      }

      const bookingCount = await countBookingsForSchedule(
        client,
        existing.id
      );
      const activeQueue = await findActiveQueueForSchedule(
        client,
        input.medicalCenterId,
        existing.id
      );

      if (bookingCount > 0 || activeQueue) {
        skipped += 1;
        continue;
      }

      await client.query(
        `
          UPDATE medical_center_doctor_schedule
          SET is_active = FALSE,
              updated_at = NOW()
          WHERE id = $1
        `,
        [existing.id]
      );
      disabled += 1;
    }

    await client.query("COMMIT");

    emitScheduleUpdate({
      doctorUserId: input.doctorUserId,
      medicalCenterId: input.medicalCenterId,
      type: "routine:saved",
    });

    return {
      message: "Routine schedule saved successfully",
      created,
      updated,
      disabled,
      skipped,
      weeks,
      schedules: createdSchedules,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
