import pool from "../config/db";
import { env } from "../config/env";
import { markInvalidClinicSchedulesForDoctor } from "./schedule.service";

export type DoctorAvailabilityInput = {
  day: string;
  startTime: string;
  endTime: string;
  maxPatients?: number | null;
  isActive?: boolean;
};

type DoctorIdOptions = {
  createIfMissing?: boolean;
};

type DoctorIdRow = { id: number };
type DoctorSearchRow = {
  id: number;
  name: string;
  specialization: string | null;
  experience_years: number | null;
  profile_image: string | null;
  clinic_status: "PENDING" | "ACTIVE" | "REJECTED" | "INACTIVE" | null;
  clinic_hidden: boolean;
  relationship_id: string | null;
};
type DoctorProfileRow = {
  id: number;
  user_id: number;
  name: string;
  email: string;
  specialization: string | null;
  qualifications: string | null;
  experience_years: number | null;
  bio: string | null;
  hospital_affiliations: string | null;
  consultation_fee: string | number | null;
  profile_image: string | null;
  languages: string | null;
  visibility: string | null;
};

const AVAILABILITY_DAY_ORDER_SQL = `
  CASE day
    WHEN 'Monday' THEN 1
    WHEN 'Tuesday' THEN 2
    WHEN 'Wednesday' THEN 3
    WHEN 'Thursday' THEN 4
    WHEN 'Friday' THEN 5
    WHEN 'Saturday' THEN 6
    WHEN 'Sunday' THEN 7
    ELSE 8
  END
`;
const APP_TZ = env.appTz;
const APP_TIME_SQL = `(now() AT TIME ZONE '${APP_TZ}')::time`;
const APP_DATE_SQL = `(now() AT TIME ZONE '${APP_TZ}')::date`;
const DAY_TO_INDEX: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  return error;
};

const validateTimeRange = (startTime: string, endTime: string) => {
  const start = new Date(`1970-01-01T${startTime}`);
  const end = new Date(`1970-01-01T${endTime}`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw createStatusError("Invalid time format", 400);
  }

  if (start >= end) {
    throw createStatusError("Invalid time range", 400);
  }
};

const normalizeDayName = (value: string) => {
  const normalized = String(value || "").trim();
  if (!DAY_TO_INDEX.hasOwnProperty(normalized)) {
    throw createStatusError("Invalid day", 400);
  }
  return normalized;
};

export const requireDoctorId = async (
  userId: number | undefined,
  options?: DoctorIdOptions
) => {
  if (!userId) {
    return null;
  }

  let doctorResult = await pool.query<DoctorIdRow>(
    `SELECT id FROM doctors WHERE user_id = $1`,
    [userId]
  );

  if (doctorResult.rows.length === 0 && options?.createIfMissing) {
    doctorResult = await pool.query<DoctorIdRow>(
      `INSERT INTO doctors (user_id) VALUES ($1) RETURNING id`,
      [userId]
    );
  }

  return doctorResult.rows[0]?.id ?? null;
};

export const getActiveShiftId = async (doctorId: number) => {
  const now = new Date();
  const dayName = now.toLocaleDateString("en-US", { weekday: "long", timeZone: APP_TZ });

  console.log(
    "getActiveShiftId",
    JSON.stringify({
      doctorId,
      serverIso: now.toISOString(),
      serverTime: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      serverDay: dayName,
    })
  );

  const shiftResult = await pool.query<{ id: number }>(
    `
    SELECT id
    FROM doctor_availability
    WHERE doctor_id = $1
      AND day = $2
      AND start_time <= ${APP_TIME_SQL}
      AND end_time >= ${APP_TIME_SQL}
    ORDER BY start_time
    LIMIT 1
    `,
    [doctorId, dayName]
  );

  return shiftResult.rows[0]?.id ?? null;
};

export const createDoctorAvailability = async (
  userId: number,
  input: DoctorAvailabilityInput
) => {
  validateTimeRange(input.startTime, input.endTime);
  const normalizedDay = normalizeDayName(input.day);

  const doctorId = await requireDoctorId(userId, { createIfMissing: true });
  if (!doctorId) {
    throw createStatusError("Doctor profile not found", 404);
  }

  const overlapCheck = await pool.query(
    `
    SELECT 1
    FROM doctor_availability
    WHERE doctor_id = $1
      AND day = $2
      AND COALESCE(is_active, TRUE) = TRUE
      AND ($3 < end_time AND $4 > start_time)
    LIMIT 1
    `,
    [doctorId, normalizedDay, input.startTime, input.endTime]
  );

  if (overlapCheck.rows.length > 0) {
    throw createStatusError("Time slot overlaps with existing schedule", 400);
  }

  const result = await pool.query(
    `
    INSERT INTO doctor_availability (
      doctor_id,
      day,
      day_of_week,
      start_time,
      end_time,
      max_patients,
      is_active
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
    `,
    [
      doctorId,
      normalizedDay,
      DAY_TO_INDEX[normalizedDay],
      input.startTime,
      input.endTime,
      input.maxPatients ?? null,
      input.isActive ?? true,
    ]
  );

  return result.rows[0];
};

export const listDoctorAvailability = async (userId: number) => {
  const doctorId = await requireDoctorId(userId);
  if (!doctorId) {
    return [];
  }

  const result = await pool.query(
    `
    SELECT id, day, day_of_week, start_time, end_time, max_patients, COALESCE(is_active, TRUE) AS is_active
    FROM doctor_availability
    WHERE doctor_id = $1
    ORDER BY ${AVAILABILITY_DAY_ORDER_SQL}, start_time
    `,
    [doctorId]
  );

  return result.rows;
};

export const replaceDoctorWorkingDays = async (userId: number, days: string[]) => {
  const doctorId = await requireDoctorId(userId, { createIfMissing: true });
  if (!doctorId) {
    throw createStatusError("Doctor profile not found", 404);
  }

  await pool.query(`DELETE FROM doctor_working_days WHERE doctor_id = $1`, [doctorId]);

  for (const day of days) {
    await pool.query(
      `INSERT INTO doctor_working_days (doctor_id, day) VALUES ($1, $2)`,
      [doctorId, day]
    );
  }

  return days;
};

export const listDoctorWorkingDays = async (userId: number) => {
  const doctorId = await requireDoctorId(userId);
  if (!doctorId) {
    return [];
  }

  const result = await pool.query(
    `SELECT day FROM doctor_working_days WHERE doctor_id = $1 ORDER BY day`,
    [doctorId]
  );

  return result.rows.map((row) => row.day);
};

export const deleteDoctorAvailability = async (userId: number, availabilityId: string) => {
  const doctorId = await requireDoctorId(userId);
  if (!doctorId) {
    throw createStatusError("Doctor profile not found", 404);
  }

  const result = await pool.query(
    `
    UPDATE doctor_availability
    SET is_active = FALSE,
        updated_at = NOW()
    WHERE id = $1 AND doctor_id = $2
    RETURNING *
    `,
    [availabilityId, doctorId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Shift not found", 404);
  }

  await markInvalidClinicSchedulesForDoctor({ doctorProfileId: doctorId });
};

export const updateDoctorAvailability = async (
  userId: number,
  availabilityId: string,
  input: DoctorAvailabilityInput
) => {
  validateTimeRange(input.startTime, input.endTime);
  const normalizedDay = normalizeDayName(input.day);

  const doctorId = await requireDoctorId(userId);
  if (!doctorId) {
    throw createStatusError("Doctor profile not found", 404);
  }

  const overlapCheck = await pool.query(
    `
    SELECT 1
    FROM doctor_availability
    WHERE doctor_id = $1
      AND day = $2
      AND COALESCE(is_active, TRUE) = TRUE
      AND id != $3
      AND ($4 < end_time AND $5 > start_time)
    LIMIT 1
    `,
    [doctorId, normalizedDay, availabilityId, input.startTime, input.endTime]
  );

  if (overlapCheck.rows.length > 0) {
    throw createStatusError("Time overlaps with another shift", 400);
  }

  const result = await pool.query(
    `
    UPDATE doctor_availability
    SET day = $1,
        day_of_week = $2,
        start_time = $3,
        end_time = $4,
        max_patients = $5,
        is_active = $6,
        updated_at = NOW()
    WHERE id = $7 AND doctor_id = $8
    RETURNING *
    `,
    [
      normalizedDay,
      DAY_TO_INDEX[normalizedDay],
      input.startTime,
      input.endTime,
      input.maxPatients ?? null,
      input.isActive ?? true,
      availabilityId,
      doctorId,
    ]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Shift not found", 404);
  }

  await markInvalidClinicSchedulesForDoctor({ doctorProfileId: doctorId });

  return result.rows[0];
};

export const getDoctorDashboardData = async (userId: number) => {
  const doctorResult = await pool.query(
    `
    SELECT 
      d.id AS doctor_id,
      u.name,
      u.email,
      u.profile_image,
      d.specialization,
      d.license_number,
      d.experience_years
    FROM doctors d
    JOIN users u ON d.user_id = u.id
    WHERE u.id = $1
    `,
    [userId]
  );

  if (doctorResult.rows.length === 0) {
    throw createStatusError("Doctor profile not found", 404);
  }

  const doctor = doctorResult.rows[0];
  const activeShiftId = await getActiveShiftId(doctor.doctor_id);

  const queueResult = await pool.query(
    `
    SELECT * FROM queues
    WHERE doctor_id = $1
      AND shift_date = ${APP_DATE_SQL}
      AND ($2::int IS NULL OR shift_id = $2)
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [doctor.doctor_id, activeShiftId]
  );

  const queue = queueResult.rows[0] || null;

  return {
    doctor,
    queue: queue
      ? {
          status: queue.status,
          startedAt: queue.started_at,
          waitingCount: 0,
        }
      : null,
    currentPatient: null,
    patients: [],
  };
};

export const getDoctorQueueDashboardData = async (
  userId: number,
  options?: { scheduleId?: string }
) => {
  const doctorId = await requireDoctorId(userId);
  if (!doctorId) {
    throw createStatusError("Doctor profile not found", 404);
  }
  const requestedScheduleId = options?.scheduleId ? Number(options.scheduleId) : null;
  if (options?.scheduleId && !requestedScheduleId) {
    throw createStatusError("Invalid scheduleId", 400);
  }

  const avgConsultResult = await pool.query<{ avg_minutes: string | number | null }>(
    `
    SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60.0) AS avg_minutes
    FROM (
      SELECT started_at, completed_at
      FROM queue_patients
      WHERE doctor_id = $1
        AND status = 'COMPLETED'
        AND started_at IS NOT NULL
        AND completed_at IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT 50
    ) recent
    `,
    [doctorId]
  );

  const averageConsultationMinutes =
    Number(avgConsultResult.rows[0]?.avg_minutes ?? 0) || 10;

  const selectedScheduleResult =
    requestedScheduleId !== null
      ? await pool.query<{
          id: number;
          medical_center_id: string | null;
          medical_center_name: string | null;
          location: string | null;
          cover_image_url: string | null;
          logo_url: string | null;
          date: string;
          start_time: string | null;
          end_time: string | null;
        }>(
          `
          SELECT
            s.id,
            s.medical_center_id,
            mc.name AS medical_center_name,
            COALESCE(mc.address, mc.city) AS location,
            mc.cover_image_url,
            mc.logo_url,
            s.date::text AS date,
            s.start_time::text AS start_time,
            s.end_time::text AS end_time
          FROM medical_center_doctor_schedule s
          JOIN medical_centers mc ON mc.id = s.medical_center_id
          WHERE s.id = $1
            AND s.doctor_profile_id = $2
          LIMIT 1
          `,
          [requestedScheduleId, doctorId]
        )
      : null;

  if (requestedScheduleId !== null && !selectedScheduleResult?.rows[0]) {
    throw createStatusError("Clinic session not found for this doctor", 404);
  }

  const queueResult = await pool.query(
    `
    SELECT *
    FROM queues
    WHERE doctor_id = $1
      AND shift_date = ${APP_DATE_SQL}
      AND ($2::int IS NULL OR schedule_id = $2)
    ORDER BY
      CASE WHEN status IN ('LIVE', 'PAUSED') THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 1
    `,
    [doctorId, requestedScheduleId]
  );

  if (queueResult.rows.length === 0) {
    const selectedSchedule = selectedScheduleResult?.rows[0] ?? null;
    return {
      doctor: { id: doctorId },
      queue: selectedSchedule
        ? {
            id: null,
            status: "NOT_STARTED",
            waitingCount: 0,
            completedCount: 0,
            sessionId: selectedSchedule.id,
            medicalCenterId: selectedSchedule.medical_center_id,
            medicalCenterName: selectedSchedule.medical_center_name,
            sessionDate: selectedSchedule.date,
            sessionStart: selectedSchedule.start_time,
            sessionEnd: selectedSchedule.end_time,
            location: selectedSchedule.location,
            cover_image_url: selectedSchedule.cover_image_url,
            logo_url: selectedSchedule.logo_url,
          }
        : null,
      waitingCount: 0,
      currentPatient: null,
      patients: [],
      averageConsultationMinutes,
    };
  }

  const queue = queueResult.rows[0];
  const queueContextResult = await pool.query<{
    medical_center_name: string | null;
    location: string | null;
    cover_image_url: string | null;
    logo_url: string | null;
    session_date: string | null;
    session_start: string | null;
    session_end: string | null;
  }>(
    `
    SELECT
      mc.name AS medical_center_name,
      COALESCE(mc.address, mc.city) AS location,
      mc.cover_image_url,
      mc.logo_url,
      s.date::text AS session_date,
      s.start_time::text AS session_start,
      s.end_time::text AS session_end
    FROM queues q
    LEFT JOIN medical_center_doctor_schedule s ON s.id = q.schedule_id
    LEFT JOIN medical_centers mc ON mc.id = COALESCE(q.medical_center_id, s.medical_center_id)
    WHERE q.id = $1
    LIMIT 1
    `,
    [queue.id]
  );
  const queueContext = queueContextResult.rows[0] ?? null;

  if (queue.status === "LIVE" || queue.status === "PAUSED") {
    const scheduleWindow = queue.schedule_id
      ? await pool.query<{ start_time: string | null; end_time: string | null }>(
          `
          SELECT start_time::text, end_time::text
          FROM medical_center_doctor_schedule
          WHERE id = $1
          `,
          [queue.schedule_id]
        )
      : null;
    const shiftWindow = queue.shift_id
      ? await pool.query<{ start_time: string | null; end_time: string | null }>(
          `
          SELECT start_time::text, end_time::text
          FROM doctor_availability
          WHERE id = $1
          `,
          [queue.shift_id]
        )
      : null;

    const shiftStart = scheduleWindow?.rows[0]?.start_time ?? shiftWindow?.rows[0]?.start_time ?? null;
    const shiftEnd = scheduleWindow?.rows[0]?.end_time ?? shiftWindow?.rows[0]?.end_time ?? null;

    await pool.query(
      `
      INSERT INTO queue_patients (queue_id, doctor_id, patient_id, token_number, status, medical_center_id)
      SELECT
        $1,
        $2,
        b.patient_id,
        ROW_NUMBER() OVER (ORDER BY b.time ASC),
        'WAITING',
        $5
      FROM bookings b
      WHERE b.doctor_id = $2 AND b.date = ${APP_DATE_SQL}
        AND ($6::int IS NULL OR b.session_id = $6)
        AND ($5::uuid IS NULL OR b.medical_center_id = $5::uuid)
        AND ($3::time IS NULL OR b.time >= $3)
        AND ($4::time IS NULL OR b.time <= $4)
      AND NOT EXISTS (
        SELECT 1 FROM queue_patients qp
        WHERE qp.queue_id = $1 AND qp.patient_id = b.patient_id
      )
      `,
      [queue.id, doctorId, shiftStart, shiftEnd, queue.medical_center_id ?? null, queue.schedule_id ?? null]
    );
  }

  const patientsResult = await pool.query(
    `
    SELECT
      qp.*,
      u.name,
      u.profile_image
    FROM queue_patients qp
    JOIN users u ON qp.patient_id = u.id
    WHERE qp.queue_id = $1
    AND qp.status IN ('WAITING', 'WITH_DOCTOR')
    ORDER BY qp.token_number ASC
    `,
    [queue.id]
  );

  const patients = patientsResult.rows;

  const waitingCountResult = await pool.query<{ waiting_count: string | number }>(
    `
    SELECT COUNT(*) AS waiting_count
    FROM queue_patients
    WHERE queue_id = $1 AND status = 'WAITING'
    `,
    [queue.id]
  );

  const waitingCount = Number(waitingCountResult.rows[0]?.waiting_count ?? 0);
  const completedCountResult = await pool.query<{ completed_count: string | number }>(
    `
    SELECT COUNT(*) AS completed_count
    FROM queue_patients
    WHERE queue_id = $1 AND status = 'COMPLETED'
    `,
    [queue.id]
  );
  const completedCount = Number(completedCountResult.rows[0]?.completed_count ?? 0);

  const currentPatientResult = await pool.query(
    `
    SELECT
      qp.*,
      u.name,
      u.profile_image
    FROM queue_patients qp
    JOIN users u ON qp.patient_id = u.id
    WHERE qp.queue_id = $1
    AND qp.status = 'WITH_DOCTOR'
    LIMIT 1
    `,
    [queue.id]
  );

  const currentPatient = currentPatientResult.rows.length > 0 ? currentPatientResult.rows[0] : null;

  const waitingPatients = patients
    .filter((patient) => patient.status === "WAITING")
    .sort((left, right) => left.token_number - right.token_number);

  const waitIndexById = new Map(waitingPatients.map((patient, idx) => [patient.id, idx]));

  const patientsWithEstimate = patients.map((patient) => {
    if (patient.status !== "WAITING") {
      return { ...patient, estimatedWaitMinutes: 0, position: null };
    }

    const indexAhead = waitIndexById.get(patient.id) ?? 0;
    return {
      ...patient,
      estimatedWaitMinutes: Math.round(indexAhead * averageConsultationMinutes),
      position: indexAhead + 1,
    };
  });

  const estimatedWaitMinutes = Math.round(waitingCount * averageConsultationMinutes);

  return {
    doctor: { id: doctorId },
    queue: {
      id: queue.id,
      status: queue.status,
      startedAt: queue.started_at,
      waitingCount,
      estimatedWaitMinutes,
      sessionId: queue.schedule_id ?? null,
      medicalCenterId: queue.medical_center_id ?? null,
      medicalCenterName: queueContext?.medical_center_name ?? null,
      sessionDate: queueContext?.session_date ?? null,
      sessionStart: queueContext?.session_start ?? null,
      sessionEnd: queueContext?.session_end ?? null,
      location: queueContext?.location ?? null,
      cover_image_url: queueContext?.cover_image_url ?? null,
      logo_url: queueContext?.logo_url ?? null,
      completedCount,
    },
    currentPatient,
    patients: patientsWithEstimate,
    averageConsultationMinutes,
  };
};

export const getDoctorDailyReportData = async (userId: number, dateQuery?: string) => {
  const doctorId = await requireDoctorId(userId);
  if (!doctorId) {
    throw createStatusError("Doctor profile not found", 404);
  }

  const date = dateQuery ? new Date(dateQuery) : null;
  const reportDate =
    date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;

  const summaryResult = await pool.query(
    `
    SELECT
      COUNT(*) AS total_patients,
      COUNT(*) FILTER (WHERE qp.status = 'COMPLETED') AS completed_patients,
      COUNT(*) FILTER (WHERE qp.status = 'MISSED') AS missed_patients,
      AVG(EXTRACT(EPOCH FROM (qp.completed_at - qp.started_at)) / 60.0)
        FILTER (
          WHERE qp.status = 'COMPLETED'
            AND qp.started_at IS NOT NULL
            AND qp.completed_at IS NOT NULL
        ) AS avg_consult_minutes
    FROM queue_patients qp
    JOIN queues q ON q.id = qp.queue_id
    WHERE q.doctor_id = $1
      AND DATE(q.created_at) = COALESCE($2::date, ${APP_DATE_SQL})
    `,
    [doctorId, reportDate]
  );

  const peakHourResult = await pool.query(
    `
    SELECT
      EXTRACT(HOUR FROM qp.created_at) AS hour,
      COUNT(*) AS count
    FROM queue_patients qp
    JOIN queues q ON q.id = qp.queue_id
    WHERE q.doctor_id = $1
      AND DATE(q.created_at) = COALESCE($2::date, ${APP_DATE_SQL})
    GROUP BY hour
    ORDER BY count DESC
    LIMIT 1
    `,
    [doctorId, reportDate]
  );

  const summaryRow = summaryResult.rows[0] || {};
  const peakRow = peakHourResult.rows[0] || null;

  return {
    date: reportDate || new Date().toISOString().slice(0, 10),
    dailySummary: {
      totalPatients: Number(summaryRow.total_patients || 0),
      patientsCompleted: Number(summaryRow.completed_patients || 0),
      missedCount: Number(summaryRow.missed_patients || 0),
      averageConsultationMinutes: Number(summaryRow.avg_consult_minutes || 0),
    },
    peakHour: peakRow
      ? { hour: Number(peakRow.hour), count: Number(peakRow.count) }
      : null,
  };
};

const normalizeDoctorSearchLimit = (value?: number) => {
  if (!Number.isFinite(value)) {
    return 20;
  }
  return Math.min(Math.max(Math.trunc(Number(value)), 1), 50);
};

const normalizeDoctorSearchOffset = (value?: number) => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(Math.trunc(Number(value)), 0);
};

const toDayLabel = (dayOfWeek: number | null, dayName?: string | null) => {
  if (Number.isInteger(dayOfWeek) && dayOfWeek !== null) {
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayOfWeek] || "N/A";
  }

  const value = String(dayName || "").trim();
  return value ? value.slice(0, 3) : "N/A";
};

export const searchDoctorsDirectory = async (input?: {
  query?: string;
  specialization?: string;
  limit?: number;
  offset?: number;
  includeEmail?: boolean;
  medicalCenterId?: string;
}) => {
  const query = String(input?.query || "").trim().toLowerCase();
  const specialization = String(input?.specialization || "").trim().toLowerCase();
  const limit = normalizeDoctorSearchLimit(input?.limit);
  const offset = normalizeDoctorSearchOffset(input?.offset);

  const result = await pool.query<DoctorSearchRow>(
    `
      SELECT
        d.id,
        u.name,
        d.specialization,
        d.experience_years,
        u.profile_image,
        mcd.status AS clinic_status,
        COALESCE(mcd.is_hidden, FALSE) AS clinic_hidden,
        mcd.id::text AS relationship_id
      FROM doctors d
      JOIN users u ON u.id = d.user_id
      LEFT JOIN doctor_profile_visibility dpv ON dpv.doctor_id = d.id
      LEFT JOIN medical_center_doctors mcd
        ON mcd.doctor_id = d.user_id
       AND ($6::uuid IS NOT NULL AND mcd.medical_center_id = $6::uuid)
      WHERE LOWER(COALESCE(u.role, '')) = 'doctor'
        AND COALESCE(dpv.visibility, 'PUBLIC') = 'PUBLIC'
        AND (
          $1 = ''
          OR LOWER(u.name) LIKE '%' || $1 || '%'
          OR LOWER(COALESCE(d.specialization, '')) LIKE '%' || $1 || '%'
          OR ($5 = TRUE AND LOWER(u.email) LIKE '%' || $1 || '%')
        )
        AND ($2 = '' OR LOWER(COALESCE(d.specialization, '')) LIKE '%' || $2 || '%')
      ORDER BY
        CASE WHEN LOWER(u.name) = $1 THEN 0 ELSE 1 END,
        COALESCE(d.experience_years, 0) DESC,
        u.name ASC
      LIMIT $3 OFFSET $4
    `,
    [query, specialization, limit, offset, Boolean(input?.includeEmail), input?.medicalCenterId ?? null]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    specialization: row.specialization,
    experience_years: row.experience_years,
    profile_image: row.profile_image,
    clinic_status: row.clinic_status,
    clinic_hidden: Boolean(row.clinic_hidden),
    relationship_id: row.relationship_id,
  }));
};

export const getDoctorDirectoryProfile = async (doctorId: string | number) => {
  const result = await pool.query<DoctorProfileRow>(
    `
      SELECT
        d.id,
        d.user_id,
        u.name,
        u.email,
        d.specialization,
        d.qualifications,
        d.experience_years,
        d.bio,
        d.hospital_affiliations,
        d.consultation_fee,
        u.profile_image,
        d.languages,
        COALESCE(dpv.visibility, 'PUBLIC') AS visibility
      FROM doctors d
      JOIN users u ON u.id = d.user_id
      LEFT JOIN doctor_profile_visibility dpv ON dpv.doctor_id = d.id
      WHERE d.id = $1::int
        AND LOWER(COALESCE(u.role, '')) = 'doctor'
      LIMIT 1
    `,
    [doctorId]
  );

  const profile = result.rows[0];
  if (!profile) {
    throw createStatusError("Doctor not found", 404);
  }

  if (String(profile.visibility || "PUBLIC").toUpperCase() !== "PUBLIC") {
    throw createStatusError("Doctor profile is not publicly visible", 403);
  }

  const [availabilityResult, clinicsResult] = await Promise.all([
    pool.query<{
      day_of_week: number | null;
      day: string | null;
      start_time: string;
      end_time: string;
    }>(
      `
        SELECT day_of_week, day, start_time, end_time
        FROM doctor_availability
        WHERE doctor_id = $1
          AND COALESCE(is_active, TRUE) = TRUE
        ORDER BY COALESCE(day_of_week, 7), start_time ASC
      `,
      [profile.id]
    ),
    pool.query<{ name: string; type: string | null }>(
      `
        SELECT mc.name, mc.type
        FROM medical_center_doctors mcd
        JOIN medical_centers mc ON mc.id = mcd.medical_center_id
        WHERE mcd.doctor_id = (SELECT user_id FROM doctors WHERE id = $1)
          AND mcd.status = 'ACTIVE'
        ORDER BY mc.name ASC
      `,
      [profile.id]
    ),
  ]);

  return {
    id: profile.id,
    user_id: profile.user_id,
    name: profile.name,
    email: profile.email,
    specialization: profile.specialization,
    experience_years: profile.experience_years,
    qualifications: profile.qualifications,
    bio: profile.bio,
    affiliations: profile.hospital_affiliations,
    consultation_fee: profile.consultation_fee,
    profile_image: profile.profile_image,
    languages: profile.languages,
    availability_preview: availabilityResult.rows.map((row) => ({
      day: toDayLabel(row.day_of_week, row.day),
      start: String(row.start_time).slice(0, 5),
      end: String(row.end_time).slice(0, 5),
    })),
    clinics: clinicsResult.rows.map((row) => ({
      name: row.name,
      type: row.type,
    })),
  };
};
