import pool from "../config/db";
import { env } from "../config/env";
import { computePatientFacingSessionStatus } from "./sessionDomain.service";

const APP_TZ = env.appTz;
const APP_DATE_SQL = `(now() AT TIME ZONE '${APP_TZ}')::date`;
const APP_TIME_SQL = `(now() AT TIME ZONE '${APP_TZ}')::time`;

type AppError = Error & { statusCode?: number };

type ClinicDoctorRow = {
  doctor_id: number;
  clinic_id: string;
  name: string | null;
  specialization: string | null;
  experience_years: number | null;
  profile_image: string | null;
  clinic_name: string | null;
  booked_today: number | null;
  next_available_time: string | null;
  is_available_today: boolean | null;
};

type ClinicListRow = {
  id: string;
  name: string | null;
  address: string | null;
  city: string | null;
  type: string | null;
  status: string | null;
  queue_count: number | null;
  next_available_time: string | null;
  average_wait_minutes: number | null;
  image_url: string | null;
  logo_url: string | null;
  cover_image_url: string | null;
  doctor_count: number | null;
  is_open: boolean | null;
};

type ClinicDetailsRow = ClinicListRow & {
  phone: string | null;
  email: string | null;
  opening_time: string | null;
  closing_time: string | null;
  available_today_count: number | null;
  top_specialty: string | null;
};

type ClinicScheduleRow = {
  id: number;
  clinic_id: string;
  clinic_name: string | null;
  doctor_id: number;
  doctor_name: string | null;
  specialization: string | null;
  date: string;
  start_time: string;
  end_time: string;
  medical_center_id: string;
  slot_duration: number;
  max_patients: number;
  booked_count: number;
  queue_status: string | null;
};

type ClinicDoctorMetaRow = {
  clinic_id: string;
  clinic_name: string | null;
  doctor_id: number;
  doctor_name: string | null;
  specialization: string | null;
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
};

const normalizeTime = (value: unknown) => String(value || "").slice(0, 5);

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

const BOOKABLE_CLINIC_SQL = `
  (
    LOWER(COALESCE(mc.verification_status, 'pending')) = 'approved'
    OR (
      LOWER(COALESCE(mc.verification_status, 'pending')) = 'pending'
      AND LOWER(COALESCE(mc.status, '')) = 'approved'
    )
  )
  AND LOWER(COALESCE(mc.status, 'active')) IN ('active', 'approved')
`;

export const listClinicDoctorsForPatient = async (clinicId: string) => {
  const result = await pool.query<ClinicDoctorRow>(
    `
    SELECT
      d.id AS doctor_id,
      mc.id AS clinic_id,
      u.name,
      d.specialization,
      d.experience_years,
      u.profile_image,
      mc.name AS clinic_name,
      COALESCE(today_bookings.booked_today, 0) AS booked_today,
      next_session.start_time::text AS next_available_time,
      (next_session.id IS NOT NULL) AS is_available_today
    FROM medical_center_doctors mcd
    JOIN doctors d
      ON d.user_id = mcd.doctor_id
    JOIN users u
      ON u.id = d.user_id
    JOIN medical_centers mc
      ON mc.id = mcd.medical_center_id
    LEFT JOIN LATERAL (
      SELECT s.id, s.start_time
      FROM medical_center_doctor_schedule s
      WHERE s.medical_center_id = mcd.medical_center_id
        AND s.doctor_profile_id = d.id
        AND s.date = ${APP_DATE_SQL}
        AND s.is_active = TRUE
        AND s.end_time >= ${APP_TIME_SQL}
      ORDER BY s.start_time ASC
      LIMIT 1
    ) next_session ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS booked_today
      FROM bookings b
      WHERE b.doctor_id = d.id
        AND b.medical_center_id = mcd.medical_center_id
        AND b.date = ${APP_DATE_SQL}
        AND COALESCE(UPPER(b.status), '') NOT IN ('CANCELLED', 'MISSED')
    ) today_bookings ON TRUE
    WHERE mcd.medical_center_id = $1
      AND ${BOOKABLE_CLINIC_SQL}
      AND UPPER(COALESCE(mcd.status::text, '')) = 'ACTIVE'
    ORDER BY COALESCE(next_session.start_time::text, '99:99') ASC, u.name ASC
    `,
    [clinicId]
  );

  return {
    doctors: result.rows.map((row) => ({
      id: row.doctor_id,
      clinic_id: row.clinic_id,
      name: row.name || "Doctor",
      specialization: row.specialization || "General Physician",
      experience_years: Number(row.experience_years || 0),
      profile_image: row.profile_image,
      clinic_name: row.clinic_name || "Medical Center",
      rating: 4.7,
      review_count: 0,
      is_available_today: Boolean(row.is_available_today),
      next_available_time: row.next_available_time ? normalizeTime(row.next_available_time) : null,
    })),
  };
};

export const listClinicsForPatient = async () => {
  const result = await pool.query<ClinicListRow>(
    `
    SELECT
      mc.id,
      mc.name,
      mc.address,
      NULLIF(TRIM(COALESCE(mc.city, split_part(COALESCE(mc.address, ''), ',', 1))), '') AS city,
      mc.type,
      CASE
        WHEN live_queue.id IS NOT NULL THEN 'QUEUE LIVE'
        WHEN today_sessions.has_session = TRUE THEN 'OPEN'
        ELSE 'CLOSED'
      END AS status,
      COALESCE(queue_counts.queue_count, 0) AS queue_count,
      next_session.start_time::text AS next_available_time,
      avg_wait.average_wait_minutes,
      mc.image_url,
      mc.logo_url,
      mc.cover_image_url,
      COALESCE(active_doctors.doctor_count, 0) AS doctor_count,
      (live_queue.id IS NOT NULL OR today_sessions.has_session = TRUE) AS is_open
    FROM medical_centers mc
    LEFT JOIN LATERAL (
      SELECT q.id
      FROM queues q
      WHERE q.medical_center_id = mc.id
        AND q.shift_date = ${APP_DATE_SQL}
        AND q.status IN ('LIVE', 'PAUSED')
      ORDER BY q.created_at DESC
      LIMIT 1
    ) live_queue ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS queue_count
      FROM queue_patients qp
      JOIN queues q ON q.id = qp.queue_id
      WHERE q.medical_center_id = mc.id
        AND q.shift_date = ${APP_DATE_SQL}
        AND q.status IN ('LIVE', 'PAUSED')
        AND qp.status IN ('WAITING', 'WITH_DOCTOR')
    ) queue_counts ON TRUE
    LEFT JOIN LATERAL (
      SELECT TRUE AS has_session
      FROM medical_center_doctor_schedule s
      WHERE s.medical_center_id = mc.id
        AND s.date = ${APP_DATE_SQL}
        AND s.is_active = TRUE
      LIMIT 1
    ) today_sessions ON TRUE
    LEFT JOIN LATERAL (
      SELECT s.start_time
      FROM medical_center_doctor_schedule s
      WHERE s.medical_center_id = mc.id
        AND s.date >= ${APP_DATE_SQL}
        AND s.is_active = TRUE
        AND (s.date > ${APP_DATE_SQL} OR s.end_time >= ${APP_TIME_SQL})
      ORDER BY s.date ASC, s.start_time ASC
      LIMIT 1
    ) next_session ON TRUE
    LEFT JOIN LATERAL (
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (qp.completed_at - qp.started_at)) / 60.0))::int AS average_wait_minutes
      FROM queue_patients qp
      JOIN queues q ON q.id = qp.queue_id
      WHERE q.medical_center_id = mc.id
        AND qp.status = 'COMPLETED'
        AND qp.started_at IS NOT NULL
        AND qp.completed_at IS NOT NULL
    ) avg_wait ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS doctor_count
      FROM medical_center_doctors mcd
      JOIN doctors d ON d.user_id = mcd.doctor_id
      WHERE mcd.medical_center_id = mc.id
        AND UPPER(COALESCE(mcd.status::text, '')) = 'ACTIVE'
    ) active_doctors ON TRUE
    WHERE ${BOOKABLE_CLINIC_SQL}
    ORDER BY mc.name ASC
    `
  );

  return {
    clinics: result.rows.map((row) => ({
      id: row.id,
      name: row.name || "Medical Center",
      address: row.address,
      city: row.city || "Sri Lanka",
      type: row.type || "General",
      status: row.status || "CLOSED",
      queue_count: Number(row.queue_count || 0),
      average_wait: Number(row.average_wait_minutes || 15),
      next_available: row.next_available_time ? normalizeTime(row.next_available_time) : "09:00",
      image_url: row.image_url,
      logo_url: row.logo_url,
      cover_image_url: row.cover_image_url,
      doctor_count: Number(row.doctor_count || 0),
      is_open: typeof row.is_open === "boolean" ? row.is_open : row.status !== "CLOSED",
    })),
  };
};

export const getClinicDetailsForPatient = async (clinicId: string) => {
  const result = await pool.query<ClinicDetailsRow>(
    `
    SELECT
      mc.id,
      mc.name,
      mc.address,
      NULLIF(TRIM(COALESCE(mc.city, split_part(COALESCE(mc.address, ''), ',', 1))), '') AS city,
      mc.type,
      mc.phone,
      mc.email,
      mc.opening_time::text AS opening_time,
      mc.closing_time::text AS closing_time,
      CASE
        WHEN live_queue.id IS NOT NULL THEN 'QUEUE LIVE'
        WHEN today_sessions.has_session = TRUE THEN 'OPEN'
        ELSE 'CLOSED'
      END AS status,
      COALESCE(queue_counts.queue_count, 0) AS queue_count,
      next_session.start_time::text AS next_available_time,
      avg_wait.average_wait_minutes,
      mc.image_url,
      mc.logo_url,
      mc.cover_image_url,
      COALESCE(active_doctors.doctor_count, 0) AS doctor_count,
      COALESCE(today_sessions.available_today_count, 0) AS available_today_count,
      specialty.top_specialty,
      (live_queue.id IS NOT NULL OR today_sessions.has_session = TRUE) AS is_open
    FROM medical_centers mc
    LEFT JOIN LATERAL (
      SELECT q.id
      FROM queues q
      WHERE q.medical_center_id = mc.id
        AND q.shift_date = ${APP_DATE_SQL}
        AND q.status IN ('LIVE', 'PAUSED')
      ORDER BY q.created_at DESC
      LIMIT 1
    ) live_queue ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS queue_count
      FROM queue_patients qp
      JOIN queues q ON q.id = qp.queue_id
      WHERE q.medical_center_id = mc.id
        AND q.shift_date = ${APP_DATE_SQL}
        AND q.status IN ('LIVE', 'PAUSED')
        AND qp.status IN ('WAITING', 'WITH_DOCTOR')
    ) queue_counts ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS available_today_count, (COUNT(*) > 0) AS has_session
      FROM medical_center_doctor_schedule s
      WHERE s.medical_center_id = mc.id
        AND s.date = ${APP_DATE_SQL}
        AND s.is_active = TRUE
        AND s.end_time >= ${APP_TIME_SQL}
    ) today_sessions ON TRUE
    LEFT JOIN LATERAL (
      SELECT s.start_time
      FROM medical_center_doctor_schedule s
      WHERE s.medical_center_id = mc.id
        AND s.date >= ${APP_DATE_SQL}
        AND s.is_active = TRUE
        AND (s.date > ${APP_DATE_SQL} OR s.end_time >= ${APP_TIME_SQL})
      ORDER BY s.date ASC, s.start_time ASC
      LIMIT 1
    ) next_session ON TRUE
    LEFT JOIN LATERAL (
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (qp.completed_at - qp.started_at)) / 60.0))::int AS average_wait_minutes
      FROM queue_patients qp
      JOIN queues q ON q.id = qp.queue_id
      WHERE q.medical_center_id = mc.id
        AND qp.status = 'COMPLETED'
        AND qp.started_at IS NOT NULL
        AND qp.completed_at IS NOT NULL
    ) avg_wait ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS doctor_count
      FROM medical_center_doctors mcd
      JOIN doctors d ON d.user_id = mcd.doctor_id
      WHERE mcd.medical_center_id = mc.id
        AND UPPER(COALESCE(mcd.status::text, '')) = 'ACTIVE'
    ) active_doctors ON TRUE
    LEFT JOIN LATERAL (
      SELECT d.specialization AS top_specialty
      FROM medical_center_doctors mcd
      JOIN doctors d ON d.user_id = mcd.doctor_id
      WHERE mcd.medical_center_id = mc.id
        AND UPPER(COALESCE(mcd.status::text, '')) = 'ACTIVE'
        AND NULLIF(TRIM(COALESCE(d.specialization, '')), '') IS NOT NULL
      GROUP BY d.specialization
      ORDER BY COUNT(*) DESC, d.specialization ASC
      LIMIT 1
    ) specialty ON TRUE
    WHERE mc.id = $1
      AND ${BOOKABLE_CLINIC_SQL}
    LIMIT 1
    `,
    [clinicId]
  );

  const row = result.rows[0];
  if (!row) {
    throw createStatusError("Medical Center not found", 404);
  }

  const nextAvailable = row.next_available_time ? normalizeTime(row.next_available_time) : null;
  const waitMinutes =
    row.average_wait_minutes === null || row.average_wait_minutes === undefined
      ? null
      : Number(row.average_wait_minutes);

  return {
    clinic: {
      id: row.id,
      name: row.name || "Medical Center",
      address: row.address,
      city: row.city,
      location: row.city || row.address || null,
      type: row.type || null,
      phone: row.phone,
      email: row.email,
      status: row.status || "CLOSED",
      queue_count: Number(row.queue_count || 0),
      average_wait_minutes: waitMinutes,
      average_wait: waitMinutes === null ? null : `${waitMinutes} min`,
      next_available: nextAvailable,
      image_url: row.image_url,
      logo_url: row.logo_url,
      cover_image_url: row.cover_image_url,
      doctor_count: Number(row.doctor_count || 0),
      available_today_count: Number(row.available_today_count || 0),
      top_specialty: row.top_specialty,
      is_open: typeof row.is_open === "boolean" ? row.is_open : row.status !== "CLOSED",
      opening_time: row.opening_time ? normalizeTime(row.opening_time) : null,
      closing_time: row.closing_time ? normalizeTime(row.closing_time) : null,
    },
  };
};

export const getClinicDoctorScheduleForPatient = async (clinicId: string, doctorId: number) => {
  const doctorProfileId = await resolveDoctorProfileId(doctorId);
  if (!doctorProfileId) {
    throw createStatusError("Doctor not found for this clinic", 404);
  }

  const doctorMeta = await pool.query<ClinicDoctorMetaRow>(
    `
    SELECT
      mc.id AS clinic_id,
      mc.name AS clinic_name,
      d.id AS doctor_id,
      u.name AS doctor_name,
      d.specialization
    FROM medical_center_doctors mcd
    JOIN doctors d
      ON d.user_id = mcd.doctor_id
    JOIN users u
      ON u.id = d.user_id
    JOIN medical_centers mc
      ON mc.id = mcd.medical_center_id
    WHERE mcd.medical_center_id = $1
      AND d.id = $2
      AND ${BOOKABLE_CLINIC_SQL}
      AND UPPER(COALESCE(mcd.status::text, '')) = 'ACTIVE'
    LIMIT 1
    `,
    [clinicId, doctorProfileId]
  );

  if (doctorMeta.rows.length === 0) {
    throw createStatusError("Doctor not found for this clinic", 404);
  }

  const result = await pool.query<ClinicScheduleRow>(
    `
    SELECT
      s.id,
      s.medical_center_id AS clinic_id,
      s.medical_center_id,
      mc.name AS clinic_name,
      s.doctor_profile_id AS doctor_id,
      u.name AS doctor_name,
      d.specialization,
      s.date::text AS date,
      s.start_time::text AS start_time,
      s.end_time::text AS end_time,
      s.slot_duration,
      s.max_patients,
      COALESCE(bookings.booked_count, 0) AS booked_count,
      queue.status AS queue_status
    FROM medical_center_doctor_schedule s
    JOIN medical_centers mc
      ON mc.id = s.medical_center_id
    JOIN doctors d
      ON d.id = s.doctor_profile_id
    JOIN users u
      ON u.id = d.user_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS booked_count
      FROM bookings b
      WHERE b.session_id = s.id
        AND COALESCE(UPPER(b.status), '') NOT IN ('CANCELLED', 'MISSED')
    ) bookings ON TRUE
    LEFT JOIN LATERAL (
      SELECT q.status
      FROM queues q
      WHERE q.schedule_id = s.id
        AND q.shift_date = s.date
      ORDER BY q.created_at DESC
      LIMIT 1
    ) queue ON TRUE
    WHERE s.medical_center_id = $1
      AND ${BOOKABLE_CLINIC_SQL}
      AND s.doctor_profile_id = $2
      AND s.is_active = TRUE
      AND s.date >= ${APP_DATE_SQL}
    ORDER BY s.date ASC, s.start_time ASC
    `,
    [clinicId, doctorProfileId]
  );

  if (result.rows.length === 0) {
    return {
      clinic_id: doctorMeta.rows[0].clinic_id,
      clinic_name: doctorMeta.rows[0].clinic_name || "Medical Center",
      doctor_id: doctorMeta.rows[0].doctor_id,
      doctor_name: doctorMeta.rows[0].doctor_name || "Doctor",
      specialization: doctorMeta.rows[0].specialization || "General Physician",
      next_session: null,
      sessions: [],
    };
  }

  const sessions = result.rows.map((row) => {
    const bookedCount = Number(row.booked_count || 0);
    const maxPatients = Number(row.max_patients || 0);
    const availableSlots = Math.max(maxPatients - bookedCount, 0);

    return {
      id: row.id,
      medical_center_id: row.medical_center_id,
      date: row.date,
      start_time: normalizeTime(row.start_time),
      end_time: normalizeTime(row.end_time),
      slot_duration: row.slot_duration,
      max_patients: maxPatients,
      booked_count: bookedCount,
      available_slots: availableSlots,
      is_fully_booked: availableSlots <= 0,
      status: computePatientFacingSessionStatus({
        date: row.date,
        startTime: row.start_time,
        endTime: row.end_time,
        queueStatus: row.queue_status,
        isActive: true,
      }),
    };
  });

  return {
    clinic_id: result.rows[0].clinic_id,
    clinic_name: result.rows[0].clinic_name || "Medical Center",
    doctor_id: result.rows[0].doctor_id,
    doctor_name: result.rows[0].doctor_name || "Doctor",
    specialization: result.rows[0].specialization || "General Physician",
    next_session:
      sessions.find((session) => session.status !== "CLOSED" && session.available_slots > 0) ??
      sessions.find((session) => session.status !== "CLOSED") ??
      null,
    sessions,
  };
};
