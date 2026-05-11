import type { Pool, PoolClient } from "pg";
import { env } from "../config/env";

type DbClient = Pool | PoolClient;

export type BookableClinicSessionRow = {
  id: number;
  doctor_profile_id: number;
  medical_center_id: string;
  date: string;
  start_time: string;
  end_time: string;
  slot_duration: number;
  max_patients: number;
  is_active: boolean;
};

const APP_TZ = env.appTz;

export const normalizeSessionTime = (value: unknown) => String(value || "").trim().slice(0, 5);

export const parseSessionTimeToMinutes = (value: string) => {
  const normalized = normalizeSessionTime(value);
  const match = normalized.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
};

export const buildSessionDateTime = (date: string, time: string) => {
  const normalizedTime = normalizeSessionTime(time);
  const [hours, minutes] = normalizedTime.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }

  const [year, month, day] = String(date || "").split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const parsed = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const computeClinicSessionStatus = (
  date: string,
  startTime: string,
  endTime: string,
  isActive = true
) => {
  if (!isActive) {
    return "COMPLETED" as const;
  }

  const now = new Date();
  const start = buildSessionDateTime(date, startTime);
  const end = buildSessionDateTime(date, endTime);

  if (start && end) {
    if (now >= end) {
      return "COMPLETED" as const;
    }

    if (now >= start && now < end) {
      return "ACTIVE" as const;
    }
  }

  return "UPCOMING" as const;
};

export const computePatientFacingSessionStatus = (input: {
  date: string;
  startTime: string;
  endTime: string;
  queueStatus?: string | null;
  isActive?: boolean;
}) => {
  const queueStatus = String(input.queueStatus || "").trim().toUpperCase();
  if (!input.isActive) {
    return "CLOSED" as const;
  }
  if (queueStatus === "LIVE" || queueStatus === "PAUSED") {
    return "LIVE" as const;
  }

  return computeClinicSessionStatus(input.date, input.startTime, input.endTime, true) === "COMPLETED"
    ? ("CLOSED" as const)
    : ("NOT_STARTED" as const);
};

export const generateSessionTimeSlots = (input: {
  startTime: string;
  endTime: string;
  slotDuration: number;
  maxPatients: number;
}) => {
  const startMinutes = parseSessionTimeToMinutes(input.startTime);
  const endMinutes = parseSessionTimeToMinutes(input.endTime);

  if (
    startMinutes == null ||
    endMinutes == null ||
    endMinutes <= startMinutes ||
    !Number.isInteger(input.slotDuration) ||
    input.slotDuration <= 0 ||
    !Number.isInteger(input.maxPatients) ||
    input.maxPatients <= 0
  ) {
    return [];
  }

  const generatedSlots: string[] = [];
  for (
    let minutes = startMinutes;
    minutes + input.slotDuration <= endMinutes && generatedSlots.length < input.maxPatients;
    minutes += input.slotDuration
  ) {
    generatedSlots.push(
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
    );
  }

  return generatedSlots;
};

export const isTimeWithinSessionSlots = (time: string, session: {
  start_time: string;
  end_time: string;
  slot_duration: number;
  max_patients: number;
}) =>
  generateSessionTimeSlots({
    startTime: session.start_time,
    endTime: session.end_time,
    slotDuration: session.slot_duration,
    maxPatients: session.max_patients,
  }).includes(normalizeSessionTime(time));

export const findBookableClinicSessionByTime = async (
  db: DbClient,
  input: {
    doctorProfileId: number;
    clinicId: string;
    date: string;
    time: string;
  }
) => {
  const result = await db.query<BookableClinicSessionRow>(
    `
    SELECT
      id,
      doctor_profile_id,
      medical_center_id,
      date::text AS date,
      start_time::text AS start_time,
      end_time::text AS end_time,
      slot_duration,
      max_patients,
      is_active
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
    [input.doctorProfileId, input.clinicId, input.date, input.time]
  );

  return result.rows[0] ?? null;
};

export const findClinicSessionById = async (db: DbClient, sessionId: number) => {
  const result = await db.query<BookableClinicSessionRow>(
    `
    SELECT
      id,
      doctor_profile_id,
      medical_center_id,
      date::text AS date,
      start_time::text AS start_time,
      end_time::text AS end_time,
      slot_duration,
      max_patients,
      is_active
    FROM medical_center_doctor_schedule
    WHERE id = $1
    LIMIT 1
    `,
    [sessionId]
  );

  return result.rows[0] ?? null;
};

export const formatDateKeyInAppTimeZone = (value: Date) => {
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

export const getTodayDateKeyInAppTimeZone = () => formatDateKeyInAppTimeZone(new Date());

export const getMonthDateRange = (month: string) => {
  const [year, monthValue] = month.split("-").map(Number);
  const first = new Date(year, monthValue - 1, 1);
  const last = new Date(year, monthValue, 0);

  return {
    fromDate: formatDateKeyInAppTimeZone(first),
    toDate: formatDateKeyInAppTimeZone(last),
  };
};
