import pool from "../config/db";
import { env } from "../config/env";
import { io } from "../server";
import { emitClinicPublicQueueUpdate } from "./clinicRealtime.service";
import { SOCKET_EVENTS, logRealtimeEmit } from "./realtime.service";
import { filterExpoTokens, sendExpoPush } from "../utils/expoPush";
import { BOOKING_STATUS, updateNearestBookingStatus } from "../utils/bookingLifecycle";

const doctorRoom = (doctorId: number | string) => `doctor-${doctorId}`;
const receptionRoom = "reception";
const APP_TZ = env.appTz;
const APP_TIME_SQL = `(now() AT TIME ZONE '${APP_TZ}')::time`;
const APP_DATE_SQL = `(now() AT TIME ZONE '${APP_TZ}')::date`;

type HttpError = Error & { statusCode?: number };

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

const BOOKABLE_CLINIC_ASSIGNMENT_SQL = `
  (
    LOWER(COALESCE(mc.verification_status, 'pending')) = 'approved'
    OR (
      LOWER(COALESCE(mc.verification_status, 'pending')) = 'pending'
      AND LOWER(COALESCE(mc.status, '')) = 'approved'
    )
  )
  AND LOWER(COALESCE(mc.status, 'active')) IN ('active', 'approved')
`;

type PatientDoctorProfileRow = {
  id: number;
  name: string | null;
  specialization: string | null;
  experience_years: number | null;
  qualifications: string | null;
  bio: string | null;
  profile_image: string | null;
  verification_status: string | null;
};

type PatientDoctorWorkplaceRow = {
  medical_center_id: string;
  medical_center_name: string | null;
  city: string | null;
  address: string | null;
  image_url: string | null;
  logo_url: string | null;
  cover_image_url: string | null;
};

type PatientDoctorWorkplaceSessionRow = {
  medical_center_id: string;
  session_id: number;
  date: string;
  start_time: string;
  end_time: string;
  available_slots: number;
  queue_started: boolean;
};

const getMissedAppointmentFallback = async (doctorId: string, patientId: number) => {
  const missedResult = await pool.query(
    `
    UPDATE bookings
    SET status = 'MISSED',
        missed_at = NOW()
    WHERE doctor_id = $1
      AND patient_id = $2
      AND date = ${APP_DATE_SQL}
      AND time < ${APP_TIME_SQL}
      AND COALESCE(UPPER(status), '') = 'BOOKED'
    RETURNING id
    `,
    [doctorId, patientId]
  );

  if (missedResult.rows.length > 0) {
    try {
      const tokenResult = await pool.query<{ expo_push_token: string | null }>(
        `SELECT expo_push_token FROM patient_profiles WHERE user_id = $1`,
        [patientId]
      );
      const tokens = filterExpoTokens(tokenResult.rows.map((row) => row.expo_push_token));
      await sendExpoPush(
        tokens.map((token) => ({
          to: token,
          title: "Appointment Missed",
          body: "Your appointment time has passed.",
          data: { doctorId },
        }))
      );
    } catch (error) {
      console.error("Missed appointment push error:", error);
    }
  }

  return {
    status: "NOT_STARTED",
    queueStarted: false,
    actualStartTime: null,
    waitingCount: 0,
    currentToken: null,
    nextToken: 1,
    nowServing: 0,
    yourPosition: null,
    totalQueue: 0,
    estimatedWait: 0,
    isFull: false,
    capacity: null,
    preBookedCount: 0,
    queueStartTime: null,
    patientToken: null,
  };
};

export const listDoctorAvailabilityForPatient = async (doctorId: string) => {
  const result = await pool.query(
    `
    SELECT day, start_time, end_time, max_patients
    FROM doctor_availability
    WHERE doctor_id = $1
    ORDER BY CASE day
      WHEN 'Monday' THEN 1
      WHEN 'Tuesday' THEN 2
      WHEN 'Wednesday' THEN 3
      WHEN 'Thursday' THEN 4
      WHEN 'Friday' THEN 5
      WHEN 'Saturday' THEN 6
      WHEN 'Sunday' THEN 7
      ELSE 8
    END
    `,
    [doctorId]
  );

  return result.rows;
};

export const listDoctorWorkingDaysForPatient = async (doctorId: string) => {
  const result = await pool.query(
    `SELECT day FROM doctor_working_days WHERE doctor_id = $1 ORDER BY day`,
    [doctorId]
  );

  return result.rows.map((row) => row.day);
};

export const getDoctorQueueStatusForPatient = async (
  doctorId: string,
  patientId: number,
  clinicId?: string
) => {
  if (clinicId) {
    const liveQueueResult = await pool.query(
      `
      SELECT *
      FROM queues
      WHERE doctor_id = $1
        AND medical_center_id = $2
        AND shift_date = ${APP_DATE_SQL}
        AND status IN ('LIVE', 'PAUSED')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [doctorId, clinicId]
    );

    if (liveQueueResult.rows.length > 0) {
      const queue = liveQueueResult.rows[0];

      const [waitingCountResult, currentPatientResult, maxTokenResult, patientRowResult, totalCountResult, avgConsultResult] =
        await Promise.all([
          pool.query(
            `SELECT COUNT(*) AS waiting_count FROM queue_patients WHERE queue_id = $1 AND status = 'WAITING'`,
            [queue.id]
          ),
          pool.query(
            `SELECT token_number FROM queue_patients WHERE queue_id = $1 AND status = 'WITH_DOCTOR' LIMIT 1`,
            [queue.id]
          ),
          pool.query(
            `SELECT MAX(token_number) AS max_token FROM queue_patients WHERE queue_id = $1`,
            [queue.id]
          ),
          pool.query(
            `
            SELECT status, token_number, missed_at
            FROM queue_patients
            WHERE queue_id = $1 AND patient_id = $2
            ORDER BY id DESC
            LIMIT 1
            `,
            [queue.id, patientId]
          ),
          pool.query(
            `SELECT COUNT(*) AS total_count FROM queue_patients WHERE queue_id = $1 AND status IN ('WAITING', 'WITH_DOCTOR')`,
            [queue.id]
          ),
          pool.query(
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
          ),
        ]);

      const waitingCount = Number(waitingCountResult.rows[0]?.waiting_count ?? 0);
      const currentToken =
        currentPatientResult.rows.length > 0 ? currentPatientResult.rows[0].token_number : null;
      const maxToken = Number(maxTokenResult.rows[0]?.max_token ?? 0);
      const patientRow = patientRowResult.rows[0] ?? null;
      const patientStatus = patientRow?.status ?? null;
      const patientToken =
        patientStatus && ["WAITING", "WITH_DOCTOR"].includes(patientStatus)
          ? patientRow?.token_number ?? null
          : null;
      const totalCount = Number(totalCountResult.rows[0]?.total_count ?? 0);
      const averageConsultMinutes = Number(avgConsultResult.rows[0]?.avg_minutes ?? 0) || 10;
      const estimatedWaitMinutes = Math.round(waitingCount * averageConsultMinutes);

      return {
        sessionId: queue.schedule_id ?? null,
        status: queue.status === "PAUSED" ? "PAUSED" : "LIVE",
        queueStarted: queue.status === "LIVE",
        actualStartTime: queue.started_at ?? null,
        waitingCount,
        currentToken,
        nextToken: maxToken + 1,
        nowServing: currentToken ?? 0,
        yourPosition:
          patientToken != null ? Math.max(patientToken - (currentToken ?? 0), 0) : null,
        totalQueue: totalCount,
        estimatedWait: estimatedWaitMinutes,
        isFull: false,
        capacity: null,
        estimatedWaitMinutes,
        preBookedCount: totalCount,
        queueStartTime: null,
        patientToken,
        patientStatus,
        patientMissedAt: patientRow?.missed_at ?? null,
      };
    }

    const clinicSessionResult = await pool.query<{
      id: number;
      start_time: string;
      end_time: string;
      booked_count: number;
    }>(
      `
      SELECT
        s.id,
        s.start_time::text AS start_time,
        s.end_time::text AS end_time,
        COALESCE(bookings.booked_count, 0) AS booked_count
      FROM medical_center_doctor_schedule s
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS booked_count
        FROM bookings b
        WHERE b.session_id = s.id
          AND COALESCE(UPPER(b.status), '') NOT IN ('CANCELLED', 'MISSED')
      ) bookings ON TRUE
      WHERE s.doctor_profile_id = $1
        AND s.medical_center_id = $2
        AND s.date = ${APP_DATE_SQL}
        AND s.is_active = TRUE
      ORDER BY s.start_time ASC
      LIMIT 1
      `,
      [doctorId, clinicId]
    );

    const session = clinicSessionResult.rows[0];
    if (session) {
      return {
        sessionId: session.id,
        status: "NOT_STARTED",
        queueStarted: false,
        actualStartTime: null,
        waitingCount: 0,
        currentToken: null,
        nextToken: Number(session.booked_count ?? 0) + 1,
        nowServing: 0,
        yourPosition: null,
        totalQueue: 0,
        estimatedWait: 0,
        isFull: false,
        capacity: null,
        estimatedWaitMinutes: 0,
        preBookedCount: Number(session.booked_count ?? 0),
        queueStartTime: session.start_time,
        patientToken: null,
        patientStatus: null,
      };
    }
  }

  const liveQueueResult = await pool.query(
    `
    SELECT *
    FROM queues
    WHERE doctor_id = $1
      AND shift_date = ${APP_DATE_SQL}
      AND status IN ('LIVE', 'PAUSED')
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [doctorId]
  );

  if (liveQueueResult.rows.length > 0) {
    const queue = liveQueueResult.rows[0];

    const waitingCountResult = await pool.query(
      `
      SELECT COUNT(*) AS waiting_count
      FROM queue_patients
      WHERE queue_id = $1 AND status = 'WAITING'
      `,
      [queue.id]
    );
    const waitingCount = Number(waitingCountResult.rows[0]?.waiting_count ?? 0);

    const currentPatientResult = await pool.query(
      `
      SELECT token_number
      FROM queue_patients
      WHERE queue_id = $1 AND status = 'WITH_DOCTOR'
      LIMIT 1
      `,
      [queue.id]
    );
    const currentToken =
      currentPatientResult.rows.length > 0 ? currentPatientResult.rows[0].token_number : null;

    const maxTokenResult = await pool.query(
      `
      SELECT MAX(token_number) AS max_token
      FROM queue_patients
      WHERE queue_id = $1
      `,
      [queue.id]
    );
    const maxToken = Number(maxTokenResult.rows[0]?.max_token ?? 0);

    const patientRowResult = await pool.query(
      `
      SELECT status, token_number, missed_at
      FROM queue_patients
      WHERE queue_id = $1 AND patient_id = $2
      ORDER BY id DESC
      LIMIT 1
      `,
      [queue.id, patientId]
    );
    const patientRow = patientRowResult.rows[0] ?? null;
    const patientStatus = patientRow?.status ?? null;
    const patientToken =
      patientStatus && ["WAITING", "WITH_DOCTOR"].includes(patientStatus)
        ? patientRow?.token_number ?? null
        : null;

    const totalCountResult = await pool.query(
      `
      SELECT COUNT(*) AS total_count
      FROM queue_patients
      WHERE queue_id = $1 AND status IN ('WAITING', 'WITH_DOCTOR')
      `,
      [queue.id]
    );
    const totalCount = Number(totalCountResult.rows[0]?.total_count ?? 0);

    const avgConsultResult = await pool.query(
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
    const averageConsultMinutes =
      Number(avgConsultResult.rows[0]?.avg_minutes ?? 0) || 10;
    const estimatedWaitMinutes = Math.round(waitingCount * averageConsultMinutes);

    return {
      status: queue.status === "PAUSED" ? "PAUSED" : "LIVE",
      queueStarted: queue.status === "LIVE",
      actualStartTime: queue.started_at ?? null,
      waitingCount,
      currentToken,
      nextToken: maxToken + 1,
      nowServing: currentToken ?? 0,
      yourPosition:
        patientToken != null ? Math.max(patientToken - (currentToken ?? 0), 0) : null,
      totalQueue: totalCount,
      estimatedWait: estimatedWaitMinutes,
      isFull: false,
      capacity: null,
      estimatedWaitMinutes,
      preBookedCount: 0,
      queueStartTime: null,
      patientToken,
      patientStatus,
      patientMissedAt: patientRow?.missed_at ?? null,
    };
  }

  const dayName = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: APP_TZ });
  const shiftResult = await pool.query(
    `
    SELECT id, start_time, end_time
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
  const activeShiftId = shiftResult.rows[0]?.id ?? null;

  const shiftStart = shiftResult.rows[0]?.start_time ?? null;
  const shiftEnd = shiftResult.rows[0]?.end_time ?? null;
  const preBookedResult = await pool.query(
    `
    SELECT COUNT(*) AS booked_count
    FROM bookings
    WHERE doctor_id = $1 AND date = ${APP_DATE_SQL}
      AND ($2::time IS NULL OR time >= $2)
      AND ($3::time IS NULL OR time <= $3)
    `,
    [doctorId, shiftStart, shiftEnd]
  );
  const preBookedCount = Number(preBookedResult.rows[0]?.booked_count ?? 0);
  const queueStartTime = shiftResult.rows[0]?.start_time ?? null;

  if (!activeShiftId) {
    const fallback = await getMissedAppointmentFallback(doctorId, patientId);
    return {
      ...fallback,
      preBookedCount,
      queueStartTime,
    };
  }

  const queueResult = await pool.query(
    `
    SELECT *
    FROM queues
    WHERE doctor_id = $1
      AND shift_date = ${APP_DATE_SQL}
      AND shift_id = $2
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [doctorId, activeShiftId]
  );

  if (queueResult.rows.length === 0) {
    const fallback = await getMissedAppointmentFallback(doctorId, patientId);
    return {
      ...fallback,
      preBookedCount,
      queueStartTime,
    };
  }

  const queue = queueResult.rows[0];
  const waitingCountResult = await pool.query(
    `
    SELECT COUNT(*) AS waiting_count
    FROM queue_patients
    WHERE queue_id = $1 AND status = 'WAITING'
    `,
    [queue.id]
  );
  const waitingCount = Number(waitingCountResult.rows[0]?.waiting_count ?? 0);

  const currentPatientResult = await pool.query(
    `
    SELECT token_number
    FROM queue_patients
    WHERE queue_id = $1 AND status = 'WITH_DOCTOR'
    LIMIT 1
    `,
    [queue.id]
  );
  const currentToken =
    currentPatientResult.rows.length > 0 ? currentPatientResult.rows[0].token_number : null;

  const maxTokenResult = await pool.query(
    `
    SELECT MAX(token_number) AS max_token
    FROM queue_patients
    WHERE queue_id = $1
    `,
    [queue.id]
  );
  const maxToken = Number(maxTokenResult.rows[0]?.max_token ?? 0);

  const patientTokenResult = await pool.query(
    `
    SELECT token_number
    FROM queue_patients
    WHERE queue_id = $1 AND patient_id = $2
      AND status IN ('WAITING', 'WITH_DOCTOR')
    LIMIT 1
    `,
    [queue.id, patientId]
  );
  const patientToken =
    patientTokenResult.rows.length > 0 ? patientTokenResult.rows[0].token_number : null;

  const totalCountResult = await pool.query(
    `
    SELECT COUNT(*) AS total_count
    FROM queue_patients
    WHERE queue_id = $1 AND status IN ('WAITING', 'WITH_DOCTOR')
    `,
    [queue.id]
  );
  const totalCount = Number(totalCountResult.rows[0]?.total_count ?? 0);

  const capacityResult = await pool.query(
    `
    SELECT COALESCE(SUM(max_patients), 0) AS capacity
    FROM doctor_availability
    WHERE doctor_id = $1 AND day = $2
    `,
    [doctorId, dayName]
  );
  const capacity = Number(capacityResult.rows[0]?.capacity ?? 0) || 0;
  const isFull = capacity > 0 ? totalCount >= capacity : false;

  const avgConsultResult = await pool.query(
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
  const averageConsultMinutes = Number(avgConsultResult.rows[0]?.avg_minutes ?? 0) || 10;
  const estimatedWaitMinutes = Math.round(waitingCount * averageConsultMinutes);
  const statusNormalized =
    queue.status === "LIVE" || queue.status === "PAUSED"
      ? "LIVE"
      : queue.status === "ENDED"
        ? "ENDED"
        : "NOT_STARTED";

  return {
    status: statusNormalized,
    queueStarted: statusNormalized === "LIVE",
    actualStartTime: queue.started_at ?? null,
    waitingCount,
    currentToken,
    nextToken: maxToken + 1,
    nowServing: currentToken ?? 0,
    yourPosition:
      patientToken != null ? Math.max(patientToken - (currentToken ?? 0), 0) : null,
    totalQueue: totalCount,
    estimatedWait: estimatedWaitMinutes,
    isFull,
    capacity: capacity || null,
    estimatedWaitMinutes,
    preBookedCount,
    queueStartTime,
    patientToken,
  };
};

export const listDoctorsForPatient = async () => {
  const dayName = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: APP_TZ });
  const tablesRes = await pool.query(`
    SELECT
      to_regclass('public.doctor_working_days') AS doctor_working_days,
      to_regclass('public.doctor_availability') AS doctor_availability,
      to_regclass('public.queues') AS queues,
      to_regclass('public.queue_patients') AS queue_patients
  `);
  const tables = tablesRes.rows[0] || {};
  const hasWorkingDays = !!tables.doctor_working_days;
  const hasAvailability = !!tables.doctor_availability;
  const hasQueues = !!tables.queues;
  const hasQueuePatients = !!tables.queue_patients;

  if (!hasWorkingDays || !hasAvailability || !hasQueues || !hasQueuePatients) {
    const basic = await pool.query(
      `
      SELECT
        d.id AS doctor_id,
        u.name,
        u.profile_image,
        d.specialization,
        d.experience_years,
        NULL::text AS city,
        NULL::uuid AS clinic_id,
        NULL::text AS clinic_name,
        NULL::int AS queue_length,
        NULL::int AS assigned_medical_centers_count,
        NULL::date AS next_session_date,
        NULL::text AS next_session_start_time,
        NULL::text AS next_session_clinic_name,
        NULL::boolean AS is_available_today
      FROM doctors d
      JOIN users u ON d.user_id = u.id
      ORDER BY u.name ASC
      `
    );
    return basic.rows.map((row) => ({
      ...row,
      queue_length: 0,
      is_available_today: false,
    }));
  }

  const result = await pool.query(
    `
    SELECT
      d.id AS doctor_id,
      u.name,
      u.profile_image,
      d.specialization,
      d.experience_years,
      clinic_assignment.city,
      clinic_assignment.clinic_id,
      clinic_assignment.clinic_name,
      qwait.waiting_count AS queue_length,
      active_clinic_counts.assigned_medical_centers_count,
      next_session.session_date::text AS next_session_date,
      next_session.start_time::text AS next_session_start_time,
      next_session.clinic_name AS next_session_clinic_name,
      (
        next_session.session_date = ${APP_DATE_SQL}
        OR (
          COALESCE(avail.has_availability, 0) = 1
          AND (
            COALESCE(wd.total_days, 0) = 0
            OR COALESCE(wd.is_working_day, 0) = 1
          )
        )
      ) AS is_available_today
    FROM doctors d
    JOIN users u ON d.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT
        mc.id AS clinic_id,
        mc.name AS clinic_name,
        NULLIF(TRIM(COALESCE(mc.city, split_part(COALESCE(mc.address, ''), ',', 1))), '') AS city
      FROM medical_center_doctors mcd
      JOIN medical_centers mc ON mc.id = mcd.medical_center_id
      WHERE mcd.doctor_id = d.user_id
        AND UPPER(COALESCE(mcd.status::text, '')) = 'ACTIVE'
        AND ${BOOKABLE_CLINIC_ASSIGNMENT_SQL}
      ORDER BY mc.name ASC
      LIMIT 1
    ) clinic_assignment ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT mcd.medical_center_id)::int AS assigned_medical_centers_count
      FROM medical_center_doctors mcd
      JOIN medical_centers mc ON mc.id = mcd.medical_center_id
      WHERE mcd.doctor_id = d.user_id
        AND UPPER(COALESCE(mcd.status::text, '')) = 'ACTIVE'
        AND ${BOOKABLE_CLINIC_ASSIGNMENT_SQL}
    ) active_clinic_counts ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        s.date AS session_date,
        s.start_time,
        mc.name AS clinic_name
      FROM medical_center_doctor_schedule s
      JOIN medical_centers mc ON mc.id = s.medical_center_id
      JOIN medical_center_doctors mcd
        ON mcd.medical_center_id = s.medical_center_id
       AND mcd.doctor_id = d.user_id
      WHERE s.doctor_profile_id = d.id
        AND s.is_active = TRUE
        AND UPPER(COALESCE(mcd.status::text, '')) = 'ACTIVE'
        AND ${BOOKABLE_CLINIC_ASSIGNMENT_SQL}
        AND s.date >= ${APP_DATE_SQL}
        AND (
          s.date > ${APP_DATE_SQL}
          OR s.end_time >= ${APP_TIME_SQL}
        )
      ORDER BY s.date ASC, s.start_time ASC, mc.name ASC
      LIMIT 1
    ) next_session ON TRUE
    LEFT JOIN (
      SELECT doctor_id,
             COUNT(*) AS total_days,
             MAX(CASE WHEN day = $1 THEN 1 ELSE 0 END) AS is_working_day
      FROM doctor_working_days
      GROUP BY doctor_id
    ) wd ON wd.doctor_id = d.id
    LEFT JOIN (
      SELECT doctor_id, 1 AS has_availability
      FROM doctor_availability
      WHERE day = $1
      GROUP BY doctor_id
    ) avail ON avail.doctor_id = d.id
    LEFT JOIN (
      SELECT q.doctor_id, COUNT(qp.id) AS waiting_count
      FROM queues q
      LEFT JOIN queue_patients qp
        ON qp.queue_id = q.id AND qp.status = 'WAITING'
      LEFT JOIN doctor_availability da ON da.id = q.shift_id
      WHERE q.shift_date = ${APP_DATE_SQL}
        AND da.day = $1
        AND da.start_time <= ${APP_TIME_SQL}
        AND da.end_time >= ${APP_TIME_SQL}
      GROUP BY q.doctor_id
    ) qwait ON qwait.doctor_id = d.id
    ORDER BY u.name ASC
    `,
    [dayName]
  );

  return result.rows;
};

const formatWorkplaceDay = (value: string) => {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: APP_TZ,
  });
};

export const getDoctorProfileForPatient = async (doctorId: string | number) => {
  const profileResult = await pool.query<PatientDoctorProfileRow>(
    `
    SELECT
      d.id,
      u.name,
      d.specialization,
      d.experience_years,
      d.qualifications,
      d.bio,
      u.profile_image,
      d.verification_status
    FROM doctors d
    JOIN users u ON u.id = d.user_id
    LEFT JOIN doctor_profile_visibility dpv ON dpv.doctor_id = d.id
    WHERE d.id = $1::int
      AND LOWER(COALESCE(u.role, '')) = 'doctor'
      AND UPPER(COALESCE(dpv.visibility, 'PUBLIC')) = 'PUBLIC'
    LIMIT 1
    `,
    [doctorId]
  );

  const profile = profileResult.rows[0];
  if (!profile) {
    throw createStatusError("Doctor not found", 404);
  }

  const workplaceResult = await pool.query<PatientDoctorWorkplaceRow>(
    `
    SELECT
      mc.id AS medical_center_id,
      mc.name AS medical_center_name,
      NULLIF(TRIM(COALESCE(mc.city, split_part(COALESCE(mc.address, ''), ',', 1))), '') AS city,
      NULLIF(TRIM(COALESCE(mc.address, '')), '') AS address,
      mc.image_url,
      mc.logo_url,
      mc.cover_image_url
    FROM medical_center_doctors mcd
    JOIN medical_centers mc ON mc.id = mcd.medical_center_id
    JOIN doctors d ON d.user_id = mcd.doctor_id
    WHERE d.id = $1::int
      AND UPPER(COALESCE(mcd.status::text, '')) = 'ACTIVE'
      AND ${BOOKABLE_CLINIC_ASSIGNMENT_SQL}
    ORDER BY mc.name ASC
    `,
    [doctorId]
  );

  const sessionResult = await pool.query<PatientDoctorWorkplaceSessionRow>(
    `
    SELECT
      s.medical_center_id,
      s.id AS session_id,
      s.date::text AS date,
      s.start_time::text AS start_time,
      s.end_time::text AS end_time,
      GREATEST(
        COALESCE(s.max_patients, 0) - COALESCE(bookings.booked_count, 0),
        0
      )::int AS available_slots,
      (queue.status IN ('LIVE', 'PAUSED')) AS queue_started
    FROM medical_center_doctor_schedule s
    JOIN doctors d ON d.id = s.doctor_profile_id
    JOIN medical_centers mc ON mc.id = s.medical_center_id
    JOIN medical_center_doctors mcd
      ON mcd.medical_center_id = s.medical_center_id
     AND mcd.doctor_id = d.user_id
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
    WHERE d.id = $1::int
      AND s.is_active = TRUE
      AND UPPER(COALESCE(mcd.status::text, '')) = 'ACTIVE'
      AND ${BOOKABLE_CLINIC_ASSIGNMENT_SQL}
      AND s.date >= ${APP_DATE_SQL}
      AND (s.date > ${APP_DATE_SQL} OR s.end_time >= ${APP_TIME_SQL})
    ORDER BY s.medical_center_id, s.date ASC, s.start_time ASC
    `,
    [doctorId]
  );

  const sessionMap = new Map<
    string,
    Array<{
      sessionId: string;
      dayOfWeek?: string;
      date?: string;
      startTime: string;
      endTime: string;
      availableSlots?: number | null;
      queueStarted?: boolean | null;
    }>
  >();

  sessionResult.rows.forEach((row) => {
    const sessions = sessionMap.get(row.medical_center_id) ?? [];
    sessions.push({
      sessionId: String(row.session_id),
      dayOfWeek: formatWorkplaceDay(row.date) ?? undefined,
      date: row.date,
      startTime: String(row.start_time).slice(0, 5),
      endTime: String(row.end_time).slice(0, 5),
      availableSlots: Number(row.available_slots ?? 0),
      queueStarted: Boolean(row.queue_started),
    });
    sessionMap.set(row.medical_center_id, sessions);
  });

  const workplaces = workplaceResult.rows
    .map((row) => {
      const sessions = sessionMap.get(row.medical_center_id) ?? [];
      return {
        medicalCenterId: row.medical_center_id,
        medicalCenterName: row.medical_center_name || "Medical Center",
        city: row.city,
        address: row.address,
        imageUrl: row.logo_url || row.image_url || row.cover_image_url || null,
        sessions,
      };
    })
    .filter((workplace) => workplace.sessions.length > 0);

  const primaryWorkplace = workplaces[0] ?? null;

  return {
    id: profile.id,
    fullName: profile.name || "Doctor",
    specialization: profile.specialization,
    experienceYears: profile.experience_years,
    qualifications: profile.qualifications,
    about: profile.bio,
    profileImageUrl: profile.profile_image,
    isVerified: ["approved", "verified"].includes(
      String(profile.verification_status || "").trim().toLowerCase()
    ),
    city: primaryWorkplace?.city ?? null,
    location: primaryWorkplace?.address ?? null,
    workplaces,
  };
};

export const joinDoctorQueueForPatient = async (
  doctorId: string | number,
  patientId: number,
  role?: string,
  clinicId?: string
) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const queueResult = await client.query(
      `
      SELECT * FROM queues
      WHERE doctor_id = $1
        AND ($2::uuid IS NULL OR medical_center_id = $2::uuid)
        AND shift_date = ${APP_DATE_SQL}
        AND status IN ('LIVE', 'PAUSED')
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [doctorId, clinicId || null]
    );

    if (queueResult.rows.length === 0) {
      throw createStatusError("No active queue today", 400);
    }

    const queue = queueResult.rows[0];
    if (queue.status === "PAUSED") {
      throw createStatusError("Queue is paused", 400);
    }
    if (queue.status !== "LIVE") {
      throw createStatusError("Queue is not live", 400);
    }

    const existing = await client.query(
      `
      SELECT 1 FROM queue_patients
      WHERE queue_id = $1
        AND patient_id = $2
        AND status IN ('WAITING', 'WITH_DOCTOR')
      LIMIT 1
      `,
      [queue.id, patientId]
    );
    if (existing.rows.length > 0) {
      throw createStatusError("Already in queue", 409);
    }

    const nextTokenResult = await client.query(
      `
      SELECT COALESCE(MAX(token_number), 0) + 1 AS next_token
      FROM queue_patients
      WHERE queue_id = $1
      `,
      [queue.id]
    );
    const nextToken = Number(nextTokenResult.rows[0]?.next_token ?? 1);

    const insertResult = await client.query<{ id: number; token_number: number }>(
      `
      INSERT INTO queue_patients (queue_id, doctor_id, patient_id, token_number, status, medical_center_id)
      VALUES ($1, $2, $3, $4, 'WAITING', $5)
      RETURNING id, token_number
      `,
      [queue.id, doctorId, patientId, nextToken, queue.medical_center_id ?? null]
    );

    await updateNearestBookingStatus(client, {
      doctorId: Number(doctorId),
      patientId: Number(patientId),
      nextStatus: BOOKING_STATUS.CONFIRMED,
      allowedCurrentStatuses: [BOOKING_STATUS.BOOKED],
    });

    await client.query("COMMIT");

    const queuePayload = {
      doctorId,
      queueId: queue.id,
      type: "PATIENT_JOINED",
      triggeredBy: role,
      patientId,
    };
    for (const room of [
      doctorRoom(doctorId),
      `doctor_${doctorId}`,
      `patient_${patientId}`,
      receptionRoom,
    ]) {
      io.to(room).emit(SOCKET_EVENTS.queueUpdate, queuePayload);
      logRealtimeEmit(SOCKET_EVENTS.queueUpdate, room, queuePayload);
    }
    if (queue.medical_center_id) {
      emitClinicPublicQueueUpdate({
        clinicId: queue.medical_center_id,
        doctorId,
        queueId: queue.id,
        sessionId: queue.schedule_id ?? null,
        type: "PATIENT_JOINED",
      });
    }

    return {
      message: "Joined queue",
      queueId: queue.id,
      tokenNumber: insertResult.rows[0]?.token_number ?? nextToken,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
