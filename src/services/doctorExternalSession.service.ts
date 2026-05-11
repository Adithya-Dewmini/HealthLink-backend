import { pool } from "../config/db";

type HttpError = Error & { statusCode?: number };

type ExternalSessionRow = {
  id: number;
  day_of_week: number;
  start_time: string;
  end_time: string;
  clinic_name: string;
  note: string | null;
};

type InternalRoutineRow = {
  day_of_week: number;
  start_time: string;
  end_time: string;
  clinic_name: string;
};

export type DoctorExternalSessionItem = {
  id: number;
  day: string;
  dayKey: number;
  startTime: string;
  endTime: string;
  clinicName: string;
  note: string | null;
  source: "external";
  hasConflict: boolean;
  conflictReason: string | null;
};

type CreateDoctorExternalSessionInput = {
  doctorUserId: number;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  clinicName: string;
  note?: string;
};

const DAY_LABELS: Record<number, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

const appError = (message: string, statusCode = 400): HttpError =>
  Object.assign(new Error(message), { statusCode });

const normalizeTime = (value: string) => String(value || "").trim().slice(0, 5);

const sortDayKey = (dayOfWeek: number) => (dayOfWeek === 0 ? 7 : dayOfWeek);

const overlaps = (
  leftStart: string,
  leftEnd: string,
  rightStart: string,
  rightEnd: string
) => leftStart < rightEnd && leftEnd > rightStart;

const formatClock = (value: string) => {
  const [hourRaw = "00", minuteRaw = "00"] = normalizeTime(value).split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const suffix = hour >= 12 ? "PM" : "AM";
  const normalizedHour = hour % 12 || 12;
  return `${normalizedHour}:${String(minute).padStart(2, "0")} ${suffix}`;
};

const validatePayload = (input: CreateDoctorExternalSessionInput) => {
  if (!Number.isInteger(input.doctorUserId) || input.doctorUserId <= 0) {
    throw appError("Unauthorized", 401);
  }

  if (!Number.isInteger(input.dayOfWeek) || input.dayOfWeek < 0 || input.dayOfWeek > 6) {
    throw appError("dayOfWeek must be between 0 and 6");
  }

  if (!TIME_PATTERN.test(input.startTime)) {
    throw appError("startTime must be a valid 24-hour time");
  }

  if (!TIME_PATTERN.test(input.endTime)) {
    throw appError("endTime must be a valid 24-hour time");
  }

  if (normalizeTime(input.startTime) >= normalizeTime(input.endTime)) {
    throw appError("startTime must be earlier than endTime");
  }

  if (!String(input.clinicName || "").trim()) {
    throw appError("clinicName is required");
  }
};

const toExternalSessionItem = (
  row: ExternalSessionRow,
  externalRows: ExternalSessionRow[],
  internalRows: InternalRoutineRow[]
): DoctorExternalSessionItem => {
  const startTime = normalizeTime(row.start_time);
  const endTime = normalizeTime(row.end_time);
  const externalConflict = externalRows.find(
    (candidate) =>
      candidate.id !== row.id &&
      candidate.day_of_week === row.day_of_week &&
      overlaps(startTime, endTime, normalizeTime(candidate.start_time), normalizeTime(candidate.end_time))
  );
  const internalConflict = internalRows.find(
    (candidate) =>
      candidate.day_of_week === row.day_of_week &&
      overlaps(startTime, endTime, normalizeTime(candidate.start_time), normalizeTime(candidate.end_time))
  );
  const conflictReason = internalConflict
    ? `This overlaps with your clinic routine at ${internalConflict.clinic_name} from ${formatClock(
        internalConflict.start_time
      )} to ${formatClock(internalConflict.end_time)}.`
    : externalConflict
      ? `This overlaps with another external session at ${externalConflict.clinic_name} from ${formatClock(
          externalConflict.start_time
        )} to ${formatClock(externalConflict.end_time)}.`
      : null;

  return {
    id: row.id,
    day: DAY_LABELS[row.day_of_week] || "Unknown",
    dayKey: row.day_of_week,
    startTime,
    endTime,
    clinicName: row.clinic_name,
    note: row.note,
    source: "external",
    hasConflict: Boolean(externalConflict || internalConflict),
    conflictReason,
  };
};

const loadActiveExternalRows = async (doctorUserId: number) => {
  const { rows } = await pool.query<ExternalSessionRow>(
    `
      SELECT
        id,
        day_of_week,
        start_time::text,
        end_time::text,
        clinic_name,
        note
      FROM doctor_external_sessions
      WHERE doctor_user_id = $1
        AND is_active = TRUE
      ORDER BY
        CASE WHEN day_of_week = 0 THEN 7 ELSE day_of_week END,
        start_time,
        end_time,
        clinic_name
    `,
    [doctorUserId]
  );

  return rows;
};

const loadInternalRoutineRows = async (doctorUserId: number) => {
  const { rows } = await pool.query<InternalRoutineRow>(
    `
      SELECT
        dr.day_of_week,
        dr.start_time::text,
        dr.end_time::text,
        mc.name AS clinic_name
      FROM doctor_routines dr
      INNER JOIN doctors d
        ON d.id = dr.doctor_id
      INNER JOIN medical_centers mc
        ON mc.id = dr.clinic_id
      WHERE d.user_id = $1
        AND dr.is_active = TRUE
    `,
    [doctorUserId]
  );

  return rows;
};

const buildExternalSessionList = async (doctorUserId: number) => {
  const [externalRows, internalRows] = await Promise.all([
    loadActiveExternalRows(doctorUserId),
    loadInternalRoutineRows(doctorUserId),
  ]);

  return externalRows
    .map((row) => toExternalSessionItem(row, externalRows, internalRows))
    .sort((left, right) => {
      if (sortDayKey(left.dayKey) !== sortDayKey(right.dayKey)) {
        return sortDayKey(left.dayKey) - sortDayKey(right.dayKey);
      }
      if (left.startTime !== right.startTime) {
        return left.startTime.localeCompare(right.startTime);
      }
      if (left.endTime !== right.endTime) {
        return left.endTime.localeCompare(right.endTime);
      }
      return left.clinicName.localeCompare(right.clinicName);
    });
};

export const listDoctorExternalSessions = async (doctorUserId: number) =>
  buildExternalSessionList(doctorUserId);

export const createDoctorExternalSession = async (input: CreateDoctorExternalSessionInput) => {
  validatePayload(input);

  await pool.query(
    `
      INSERT INTO doctor_external_sessions (
        doctor_user_id,
        day_of_week,
        start_time,
        end_time,
        clinic_name,
        note,
        is_active,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
    `,
    [
      input.doctorUserId,
      input.dayOfWeek,
      normalizeTime(input.startTime),
      normalizeTime(input.endTime),
      String(input.clinicName).trim(),
      String(input.note || "").trim() || null,
    ]
  );

  const sessions = await buildExternalSessionList(input.doctorUserId);
  const createdSession = sessions.find(
    (session) =>
      session.dayKey === input.dayOfWeek &&
      session.startTime === normalizeTime(input.startTime) &&
      session.endTime === normalizeTime(input.endTime) &&
      session.clinicName === String(input.clinicName).trim()
  );

  return {
    sessions,
    hasConflict: Boolean(createdSession?.hasConflict),
    conflictReason: createdSession?.conflictReason ?? null,
  };
};

export const deleteDoctorExternalSession = async (
  doctorUserId: number,
  externalSessionId: number
) => {
  if (!Number.isInteger(externalSessionId) || externalSessionId <= 0) {
    throw appError("Invalid external session id");
  }

  const result = await pool.query(
    `
      UPDATE doctor_external_sessions
      SET is_active = FALSE,
          updated_at = NOW()
      WHERE id = $1
        AND doctor_user_id = $2
        AND is_active = TRUE
      RETURNING id
    `,
    [externalSessionId, doctorUserId]
  );

  if (!result.rowCount) {
    throw appError("External session not found", 404);
  }

  return buildExternalSessionList(doctorUserId);
};
