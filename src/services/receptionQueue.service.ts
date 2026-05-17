import type { PoolClient } from "pg";
import { io } from "../server";
import pool from "../config/db";
import { env } from "../config/env";
import {
  BOOKING_STATUS,
  BOOKING_NOW_SQL,
  BOOKING_SCHEDULED_AT_SQL,
  DEFAULT_BOOKING_GRACE_PERIOD_MINUTES,
  markMissedBookings,
  normalizeBookingStatus,
  updateNearestBookingStatus,
} from "../utils/bookingLifecycle";
import {
  getReceptionistPermissionsByUserId,
  toReceptionistPermissionContract,
} from "./receptionistPermissions.service";
import { emitClinicPublicQueueUpdate } from "./clinicRealtime.service";
import { SOCKET_EVENTS, logRealtimeEmit } from "./realtime.service";
import { bookUnifiedSession } from "./unifiedSession.service";

const APP_TZ = env.appTz;
const APP_DATE_SQL = `(now() AT TIME ZONE '${APP_TZ}')::date`;
const LATE_CHECK_IN_ACTION =
  String(env.queueLateCheckInAction || "").trim().toLowerCase() === "mark_missed"
    ? "mark_missed"
    : "move_to_end";

type AppError = Error & { statusCode?: number; code?: string };

type QueueRow = {
  id: number;
  doctor_id: number;
  schedule_id: number | null;
  status: string;
  started_at: string | null;
};

type QueueMutationResponse<T = unknown> = {
  success: true;
  message: string;
  data: T;
};

type QueuePatientSummaryRow = {
  id: number;
  queue_id: number;
  patient_id: number | null;
  token_number: number;
  status: string;
  patient_name: string | null;
  priority: string | null;
  is_walkin: boolean | null;
};

type QueueDashboardRow = {
  session_id: number;
  doctor_id: number;
  doctor_name: string | null;
  doctor_profile_image?: string | null;
  specialty: string | null;
  medical_center_id: string;
  session_date: string;
  start_time: string;
  end_time: string;
  queue_id: number | null;
  queue_status: string | null;
  current_token: number | null;
  current_patient_name: string | null;
  next_token: number | null;
  next_patient_name: string | null;
  waiting_count: number;
  with_doctor_count: number;
  completed_count: number;
  missed_count: number;
  avg_wait_minutes: number;
};

type QueueDetailPatientRow = {
  id: number;
  patient_id: number;
  token_number: number;
  status: string;
  patient_name: string | null;
  patient_profile_image?: string | null;
  phone: string | null;
  booking_time: string | null;
  is_walkin: boolean | null;
  started_at: string | null;
  completed_at: string | null;
  missed_at: string | null;
};

type AppointmentSessionRow = {
  id: number;
  date: string;
  start_time: string;
  end_time: string;
  slot_duration: number;
  max_patients: number;
  doctor_id: number;
  doctor_name: string | null;
  specialty?: string | null;
  clinic_name?: string | null;
  queue_id?: number | null;
  queue_status?: string | null;
};

type AppointmentRow = {
  id: number;
  session_id: number | null;
  patient_name: string | null;
  doctor_name: string | null;
  date: string;
  time: string;
  status: string;
};

type ReceptionVisitRow = {
  booking_id: number;
  patient_id: number;
  patient_name: string | null;
  patient_phone: string | null;
  patient_email: string | null;
  doctor_id: number;
  doctor_name: string | null;
  specialty: string | null;
  clinic_id: string;
  clinic_name: string | null;
  session_id: number | null;
  session_date: string;
  start_time: string | null;
  end_time: string | null;
  appointment_time: string;
  booking_status: string;
  token_number: number | null;
  queue_patient_status: string | null;
  queue_id: number | null;
  queue_status: string | null;
  created_at: string;
  created_by_role: string | null;
};

type PatientListRow = {
  id: number;
  name: string | null;
  phone: string | null;
  last_visit: string | null;
  is_recent: boolean;
};

type ReceptionVisitStatus =
  | "booked"
  | "checked_in"
  | "waiting"
  | "with_doctor"
  | "completed"
  | "missed"
  | "cancelled";

const createStatusError = (message: string, statusCode: number, code?: string) => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const getTodayDateKey = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
  }).format(new Date());

const mutationResponse = <T>(
  message: string,
  data: T
): QueueMutationResponse<T> => ({
  success: true,
  message,
  data,
});

const doctorRoom = (doctorId: number | string) => `doctor_${doctorId}`;
const legacyDoctorRoom = (doctorId: number | string) => `doctor-${doctorId}`;
const patientRoom = (patientId: number | string) => `patient_${patientId}`;
const receptionRoom = "reception";

const emitQueueUpdate = (payload: {
  type: string;
  queueId?: number | null;
  sessionId?: number | null;
  doctorId?: number | null;
  patientId?: number | null;
  medicalCenterId?: string | null;
  patient?: unknown;
}) => {
  const eventPayload = { ...payload, emittedAt: new Date().toISOString() };
  if (payload.doctorId) {
    for (const room of [doctorRoom(payload.doctorId), legacyDoctorRoom(payload.doctorId)]) {
      io.to(room).emit(SOCKET_EVENTS.queueUpdate, eventPayload);
      logRealtimeEmit(SOCKET_EVENTS.queueUpdate, room, eventPayload);
    }
  }
  if (payload.patientId) {
    const room = patientRoom(payload.patientId);
    io.to(room).emit(SOCKET_EVENTS.queueUpdate, eventPayload);
    logRealtimeEmit(SOCKET_EVENTS.queueUpdate, room, eventPayload);
  }
  if (payload.medicalCenterId) {
    const room = `center_${payload.medicalCenterId}`;
    io.to(room).emit(SOCKET_EVENTS.queueUpdate, eventPayload);
    logRealtimeEmit(SOCKET_EVENTS.queueUpdate, room, eventPayload);
    emitClinicPublicQueueUpdate({
      clinicId: payload.medicalCenterId,
      doctorId: payload.doctorId ?? null,
      queueId: payload.queueId ?? null,
      sessionId: payload.sessionId ?? null,
      type: payload.type,
    });
  }
  io.to(receptionRoom).emit(SOCKET_EVENTS.queueUpdate, eventPayload);
  logRealtimeEmit(SOCKET_EVENTS.queueUpdate, receptionRoom, eventPayload);
};

const emitPatientCalled = (payload: {
  queueId: number;
  sessionId?: number | null;
  doctorId: number;
  medicalCenterId?: string | null;
  patient: QueuePatientSummaryRow;
}) => {
  emitQueueUpdate({
    type: "PATIENT_CALLED",
    queueId: payload.queueId,
    sessionId: payload.sessionId,
    doctorId: payload.doctorId,
    patientId: payload.patient.patient_id,
    medicalCenterId: payload.medicalCenterId,
    patient: payload.patient,
  });
  io.to(doctorRoom(payload.doctorId)).emit("patient:called", payload);
  io.to(legacyDoctorRoom(payload.doctorId)).emit("patient:called", payload);
  if (payload.patient.patient_id) {
    io.to(patientRoom(payload.patient.patient_id)).emit("patient:called", payload);
  }
};

const emitPatientMissed = (payload: {
  queueId: number;
  sessionId?: number | null;
  doctorId: number;
  medicalCenterId?: string | null;
  patientId?: number | null;
}) => {
  emitQueueUpdate({
    type: "PATIENT_MISSED",
    queueId: payload.queueId,
    sessionId: payload.sessionId,
    doctorId: payload.doctorId,
    patientId: payload.patientId,
    medicalCenterId: payload.medicalCenterId,
  });
  io.to(doctorRoom(payload.doctorId)).emit("patient:missed", payload);
  io.to(legacyDoctorRoom(payload.doctorId)).emit("patient:missed", payload);
  if (payload.patientId) {
    io.to(patientRoom(payload.patientId)).emit("patient:missed", payload);
  }
};

const withTransaction = async <T>(handler: (client: PoolClient) => Promise<T>) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const normalizeQueueStatus = (value: unknown) => String(value || "").trim().toUpperCase();

const isSessionEnded = (endTime: string) => {
  const now = new Date();
  const [hour, minute] = String(endTime || "")
    .slice(0, 5)
    .split(":")
    .map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return false;
  }

  const todayEnd = new Date(now);
  todayEnd.setHours(hour, minute, 0, 0);
  return todayEnd.getTime() <= now.getTime();
};

const isSessionStarted = (startTime: string) => {
  const now = new Date();
  const [hour, minute] = String(startTime || "")
    .slice(0, 5)
    .split(":")
    .map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return false;
  }

  const todayStart = new Date(now);
  todayStart.setHours(hour, minute, 0, 0);
  return todayStart.getTime() <= now.getTime();
};

const resolveQueueDisplayStatus = (
  row: Pick<QueueDashboardRow, "queue_status" | "start_time" | "end_time">
) => {
  const queueStatus = normalizeQueueStatus(row.queue_status);
  if (queueStatus === "LIVE" || queueStatus === "PAUSED") {
    return queueStatus;
  }
  if (queueStatus === "ENDED") {
    return "COMPLETED";
  }
  if (isSessionEnded(row.end_time)) {
    return "COMPLETED";
  }
  return isSessionStarted(row.start_time) ? "IDLE" : "WAITING";
};

const buildQueueCard = (row: QueueDashboardRow) => {
  const queueStatus = resolveQueueDisplayStatus(row);
  return {
    queueId: row.queue_id,
    sessionId: row.session_id,
    doctorId: row.doctor_id,
    doctorName: row.doctor_name || "Doctor",
    doctorProfileImage: row.doctor_profile_image || null,
    specialty: row.specialty || "General Physician",
    medicalCenterId: row.medical_center_id,
    sessionDate: row.session_date,
    startTime: String(row.start_time || "").slice(0, 5),
    endTime: String(row.end_time || "").slice(0, 5),
    queueStatus,
    currentToken: row.current_token,
    currentPatient: row.current_token
      ? {
          tokenNumber: row.current_token,
          patientName: row.current_patient_name || "Patient",
        }
      : null,
    nextToken: row.next_token,
    nextPatient: row.next_token
      ? {
          tokenNumber: row.next_token,
          patientName: row.next_patient_name || "Patient",
        }
      : null,
    waitingCount: Number(row.waiting_count || 0),
    withDoctorCount: Number(row.with_doctor_count || 0),
    completedCount: Number(row.completed_count || 0),
    missedCount: Number(row.missed_count || 0),
    avgWaitMinutes: Number(row.avg_wait_minutes || 0),
  };
};

const normalizeGeneratedEmailSeed = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "walk-in";

const createWalkInEmail = (name: string) =>
  `walkin+${normalizeGeneratedEmailSeed(name)}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@healthlink.local`;

const ensureQueuePatientUserForeignKey = async (client: PoolClient) => {
  await client.query(`
    DO $$
    DECLARE
      constraint_name TEXT;
    BEGIN
      IF to_regclass('public.queue_patients') IS NULL THEN
        RETURN;
      END IF;

      UPDATE queue_patients qp
      SET patient_id = NULL
      WHERE patient_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM users u
          WHERE u.id = qp.patient_id
        );

      FOR constraint_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_attribute a
          ON a.attrelid = t.oid
         AND a.attnum = ANY(c.conkey)
        WHERE t.relname = 'queue_patients'
          AND a.attname = 'patient_id'
          AND c.contype = 'f'
      LOOP
        EXECUTE format('ALTER TABLE queue_patients DROP CONSTRAINT %I', constraint_name);
      END LOOP;

      ALTER TABLE queue_patients
      ADD CONSTRAINT queue_patients_patient_id_fkey
      FOREIGN KEY (patient_id)
      REFERENCES users(id)
      ON DELETE CASCADE;
    END $$;
  `);
};

const ensureValidSessionId = (sessionId?: number | null) => {
  if (!Number.isFinite(Number(sessionId)) || Number(sessionId) <= 0) {
    throw createStatusError("Valid session id is required", 400, "INVALID_SESSION_ID");
  }

  return Number(sessionId);
};

const ensureValidAppointmentStatus = (
  value: string
): typeof BOOKING_STATUS.BOOKED | typeof BOOKING_STATUS.CONFIRMED | typeof BOOKING_STATUS.COMPLETED | typeof BOOKING_STATUS.MISSED | typeof BOOKING_STATUS.CANCELLED => {
  const normalized = String(value || "").trim().toUpperCase();

  switch (normalized) {
    case BOOKING_STATUS.BOOKED:
    case BOOKING_STATUS.CONFIRMED:
    case BOOKING_STATUS.COMPLETED:
    case BOOKING_STATUS.MISSED:
    case BOOKING_STATUS.CANCELLED:
      return normalized;
    default:
      throw createStatusError("Unsupported appointment status", 400, "UNSUPPORTED_APPOINTMENT_STATUS");
  }
};

const resolveBookingSource = (
  role: unknown,
  patientEmail?: string | null
): "patient" | "receptionist" | "admin" => {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "receptionist") return "receptionist";
  if (normalized === "medical_center_admin" || normalized === "admin") return "admin";
  if (String(patientEmail || "").trim().toLowerCase().endsWith("@healthlink.local")) {
    return "receptionist";
  }
  return "patient";
};

const resolveReceptionVisitStatus = (row: Pick<
  ReceptionVisitRow,
  "booking_status" | "queue_patient_status"
>): ReceptionVisitStatus => {
  const bookingStatus = normalizeBookingStatus(row.booking_status);
  const queueStatus = normalizeQueueStatus(row.queue_patient_status);

  if (bookingStatus === BOOKING_STATUS.CANCELLED) return "cancelled";
  if (bookingStatus === BOOKING_STATUS.MISSED) return "missed";
  if (bookingStatus === BOOKING_STATUS.COMPLETED) return "completed";
  if (queueStatus === "WITH_DOCTOR" || bookingStatus === BOOKING_STATUS.IN_PROGRESS) {
    return "with_doctor";
  }
  if (queueStatus === "WAITING") {
    return "waiting";
  }
  if (bookingStatus === BOOKING_STATUS.CONFIRMED) {
    return "checked_in";
  }
  return "booked";
};

const resolveQueue = async (medicalCenterId: string, sessionId?: number | null) => {
  const result = await pool.query<QueueRow & { doctor_name: string | null; start_time: string | null; end_time: string | null }>(
    `
    SELECT
      q.id,
      q.doctor_id,
      q.schedule_id,
      q.status,
      q.started_at,
      u.name AS doctor_name,
      s.start_time::text AS start_time,
      s.end_time::text AS end_time
    FROM queues q
    LEFT JOIN medical_center_doctor_schedule s ON s.id = q.schedule_id
    LEFT JOIN doctors d ON d.id = q.doctor_id
    LEFT JOIN users u ON u.id = d.user_id
    WHERE q.medical_center_id = $1
      AND q.shift_date = ${APP_DATE_SQL}
      AND ($2::int IS NULL OR q.schedule_id = $2)
    ORDER BY
      CASE WHEN q.status IN ('LIVE', 'PAUSED') THEN 0 ELSE 1 END,
      q.created_at DESC
    LIMIT 1
    `,
    [medicalCenterId, sessionId ?? null]
  );

  return result.rows[0] ?? null;
};

const loadQueuePayload = async (medicalCenterId: string, sessionId?: number | null) => {
  const queue = await resolveQueue(medicalCenterId, sessionId);
  if (!queue) {
    return {
      session: null,
      currentPatient: null,
      nextPatient: null,
      patients: [],
      waitingCount: 0,
      averageWaitMinutes: 0,
    };
  }

  const patientsResult = await pool.query<{
    id: number;
    patient_id: number;
    token_number: number;
    status: string;
    patient_name: string | null;
    patient_profile_image: string | null;
    phone: string | null;
    booking_time: string | null;
  }>(
    `
    SELECT
      qp.id,
      qp.patient_id,
      qp.token_number,
      qp.status,
      u.name AS patient_name,
      u.profile_image AS patient_profile_image,
      pp.phone,
      b.time::text AS booking_time
    FROM queue_patients qp
    LEFT JOIN users u ON u.id = qp.patient_id
    LEFT JOIN patient_profiles pp ON pp.user_id = qp.patient_id
    LEFT JOIN bookings b
      ON b.patient_id = qp.patient_id
     AND b.doctor_id = qP.doctor_id
     AND b.session_id = $2
     AND b.date = ${APP_DATE_SQL}
    WHERE qp.queue_id = $1
    ORDER BY qp.token_number ASC
    `,
    [queue.id, queue.schedule_id]
  );

  const patients = patientsResult.rows.map((row) => ({
    ...row,
    patient_name: row.patient_name || "Patient",
    patient_profile_image: row.patient_profile_image || null,
  }));

  const currentPatient = patients.find((row) => row.status === "WITH_DOCTOR") ?? null;
  const nextPatient = patients.find((row) => row.status === "WAITING") ?? null;
  const waitingCount = patients.filter((row) => row.status === "WAITING").length;

  return {
    session: {
      id: Number(queue.schedule_id ?? queue.id),
      doctorName: queue.doctor_name || "Doctor",
      startTime: String(queue.start_time || "").slice(0, 5),
      endTime: String(queue.end_time || "").slice(0, 5),
      status: queue.status,
    },
    currentPatient,
    nextPatient,
    patients,
    waitingCount,
    averageWaitMinutes: waitingCount * 10,
  };
};

const requireQueue = async (medicalCenterId: string, sessionId?: number | null) => {
  const queue = await resolveQueue(medicalCenterId, sessionId);
  if (!queue) {
    throw createStatusError("No queue found for this medical center session", 404, "QUEUE_NOT_FOUND");
  }
  return queue;
};

const resolveQueueByIdentifier = async (input: {
  medicalCenterId: string;
  queueId?: number | null;
  sessionId?: number | null;
}) => {
  if (input.queueId && Number(input.queueId) > 0) {
    const result = await pool.query<QueueRow>(
      `
      SELECT id, doctor_id, schedule_id, status, started_at
      FROM queues
      WHERE id = $1
        AND medical_center_id = $2
        AND shift_date = ${APP_DATE_SQL}
      LIMIT 1
      `,
      [Number(input.queueId), input.medicalCenterId]
    );
    return result.rows[0] ?? null;
  }

  if (input.sessionId && Number(input.sessionId) > 0) {
    return requireQueue(input.medicalCenterId, Number(input.sessionId));
  }

  throw createStatusError("queueId or sessionId is required", 400, "QUEUE_IDENTIFIER_REQUIRED");
};

const resolveQueueForUpdate = async (
  client: PoolClient,
  input: {
    medicalCenterId: string;
    queueId?: number | null;
    sessionId?: number | null;
  }
) => {
  const params: Array<number | string> = [input.medicalCenterId];
  const clauses = [
    "q.medical_center_id = $1",
    `q.shift_date = ${APP_DATE_SQL}`,
  ];

  if (input.queueId && Number(input.queueId) > 0) {
    params.push(Number(input.queueId));
    clauses.push(`q.id = $${params.length}`);
  } else if (input.sessionId && Number(input.sessionId) > 0) {
    params.push(Number(input.sessionId));
    clauses.push(`q.schedule_id = $${params.length}`);
  } else {
    throw createStatusError("queueId or sessionId is required", 400);
  }

  const result = await client.query<QueueRow & { medical_center_id: string | null }>(
    `
    SELECT q.id, q.doctor_id, q.schedule_id, q.status, q.started_at, q.medical_center_id
    FROM queues q
    WHERE ${clauses.join(" AND ")}
    ORDER BY
      CASE WHEN q.status IN ('LIVE', 'PAUSED') THEN 0 ELSE 1 END,
      q.created_at DESC
    LIMIT 1
    FOR UPDATE
    `,
    params
  );

  return result.rows[0] ?? null;
};

const requireLiveQueueForUpdate = async (
  client: PoolClient,
  input: {
    medicalCenterId: string;
    queueId?: number | null;
    sessionId?: number | null;
  }
) => {
  const queue = await resolveQueueForUpdate(client, input);
  if (!queue) {
    throw createStatusError("Queue not started", 400, "QUEUE_NOT_STARTED");
  }
  if (!["LIVE", "PAUSED"].includes(normalizeQueueStatus(queue.status))) {
    throw createStatusError("Queue is not active", 400, "QUEUE_NOT_ACTIVE");
  }
  return queue;
};

const getQueuePatientSummary = async (client: PoolClient, queuePatientId: number) => {
  const result = await client.query<QueuePatientSummaryRow>(
    `
    SELECT
      qp.id,
      qp.queue_id,
      qp.patient_id,
      qp.token_number,
      qp.status,
      COALESCE(u.name, 'Patient') AS patient_name,
      qp.priority,
      qp.is_walkin
    FROM queue_patients qp
    LEFT JOIN users u ON u.id = qp.patient_id
    WHERE qp.id = $1
    LIMIT 1
    `,
    [queuePatientId]
  );

  return result.rows[0] ?? null;
};

const renumberQueue = async (client: PoolClient, queueId: number) => {
  await client.query(
    `
    WITH ordered AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          ORDER BY
            token_number ASC,
            id ASC
        ) AS next_token
      FROM queue_patients
      WHERE queue_id = $1
        AND status IN ('WAITING', 'WITH_DOCTOR')
    )
    UPDATE queue_patients qp
    SET token_number = ordered.next_token
    FROM ordered
    WHERE qp.id = ordered.id
    `,
    [queueId]
  );
};

const insertQueuePatientAtPosition = async (
  client: PoolClient,
  input: {
    queueId: number;
    doctorId: number;
    patientId: number;
    medicalCenterId: string;
    sessionId?: number | null;
    position: number;
    isWalkIn: boolean;
    priority: "normal" | "urgent" | "emergency";
  }
) => {
  await client.query(
    `
    UPDATE queue_patients
    SET token_number = token_number + 1
    WHERE queue_id = $1
      AND status IN ('WAITING', 'WITH_DOCTOR')
      AND token_number >= $2
    `,
    [input.queueId, input.position]
  );

  const insert = await client.query<{ id: number; token_number: number }>(
    `
    INSERT INTO queue_patients (
      queue_id,
      doctor_id,
      patient_id,
      token_number,
      status,
      medical_center_id,
      session_id,
      checked_in_at,
      is_walkin,
      priority
    )
    VALUES ($1, $2, $3, $4, 'WAITING', $5, $6, NOW(), $7, $8)
    RETURNING id, token_number
    `,
    [
      input.queueId,
      input.doctorId,
      input.patientId,
      input.position,
      input.medicalCenterId,
      input.sessionId ?? null,
      input.isWalkIn,
      input.priority,
    ]
  );

  await renumberQueue(client, input.queueId);
  return insert.rows[0];
};

const getEndPosition = async (client: PoolClient, queueId: number) => {
  const result = await client.query<{ next_position: number }>(
    `
    SELECT COALESCE(MAX(token_number), 0)::int + 1 AS next_position
    FROM queue_patients
    WHERE queue_id = $1
      AND status IN ('WAITING', 'WITH_DOCTOR')
    `,
    [queueId]
  );
  return Number(result.rows[0]?.next_position || 1);
};

const getUrgentPosition = async (client: PoolClient, queueId: number) => {
  const current = await client.query<{ token_number: number }>(
    `
    SELECT token_number
    FROM queue_patients
    WHERE queue_id = $1
      AND status = 'WITH_DOCTOR'
    ORDER BY token_number ASC
    LIMIT 1
    `,
    [queueId]
  );

  return Number(current.rows[0]?.token_number || 0) + 1 || 1;
};

const normalizePriority = (value: unknown): "normal" | "urgent" | "emergency" => {
  const normalized = String(value || "normal").trim().toLowerCase();
  if (normalized === "emergency" || normalized === "urgent" || normalized === "normal") {
    return normalized;
  }
  throw createStatusError("priority must be normal, urgent, or emergency", 400);
};

const getQueueDashboardRows = async (medicalCenterId: string) => {
  const result = await pool.query<QueueDashboardRow>(
    `
    SELECT
      s.id AS session_id,
      d.id AS doctor_id,
      u.name AS doctor_name,
      u.profile_image AS doctor_profile_image,
      d.specialization AS specialty,
      s.medical_center_id,
      s.date::text AS session_date,
      s.start_time::text AS start_time,
      s.end_time::text AS end_time,
      q.id AS queue_id,
      q.status AS queue_status,
      current_patient.token_number AS current_token,
      current_patient.patient_name AS current_patient_name,
      next_patient.token_number AS next_token,
      next_patient.patient_name AS next_patient_name,
      COALESCE(waiting_counts.waiting_count, 0)::int AS waiting_count,
      COALESCE(with_doctor_counts.with_doctor_count, 0)::int AS with_doctor_count,
      COALESCE(completed_counts.completed_count, 0)::int AS completed_count,
      COALESCE(missed_counts.missed_count, 0)::int AS missed_count,
      COALESCE(avg_wait.avg_wait_minutes, 0)::int AS avg_wait_minutes
    FROM medical_center_doctor_schedule s
    JOIN doctors d ON d.id = s.doctor_profile_id
    JOIN users u ON u.id = d.user_id
    LEFT JOIN queues q
      ON q.schedule_id = s.id
     AND q.medical_center_id = s.medical_center_id
     AND q.shift_date = ${APP_DATE_SQL}
    LEFT JOIN LATERAL (
      SELECT qp.token_number, patient_user.name AS patient_name
      FROM queue_patients qp
      LEFT JOIN users patient_user ON patient_user.id = qp.patient_id
      WHERE qp.queue_id = q.id
        AND qp.status = 'WITH_DOCTOR'
      ORDER BY qp.started_at DESC NULLS LAST, qp.token_number ASC
      LIMIT 1
    ) current_patient ON TRUE
    LEFT JOIN LATERAL (
      SELECT qp.token_number, patient_user.name AS patient_name
      FROM queue_patients qp
      LEFT JOIN users patient_user ON patient_user.id = qp.patient_id
      WHERE qp.queue_id = q.id
        AND qp.status = 'WAITING'
      ORDER BY qp.token_number ASC
      LIMIT 1
    ) next_patient ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS waiting_count
      FROM queue_patients qp
      WHERE qp.queue_id = q.id
        AND qp.status = 'WAITING'
    ) waiting_counts ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS with_doctor_count
      FROM queue_patients qp
      WHERE qp.queue_id = q.id
        AND qp.status = 'WITH_DOCTOR'
    ) with_doctor_counts ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS completed_count
      FROM queue_patients qp
      WHERE qp.queue_id = q.id
        AND qp.status = 'COMPLETED'
    ) completed_counts ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS missed_count
      FROM queue_patients qp
      WHERE qp.queue_id = q.id
        AND qp.status = 'MISSED'
    ) missed_counts ON TRUE
    LEFT JOIN LATERAL (
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (qp.completed_at - qp.started_at)) / 60.0))::int AS avg_wait_minutes
      FROM queue_patients qp
      WHERE qp.queue_id = q.id
        AND qp.status = 'COMPLETED'
        AND qp.started_at IS NOT NULL
        AND qp.completed_at IS NOT NULL
    ) avg_wait ON TRUE
    WHERE s.medical_center_id = $1
      AND s.date = ${APP_DATE_SQL}
      AND s.is_active = TRUE
    ORDER BY s.start_time ASC, u.name ASC
    `,
    [medicalCenterId]
  );

  return result.rows;
};

const loadQueuePatientsByQueueId = async (queueId: number) => {
  const result = await pool.query<QueueDetailPatientRow>(
    `
    SELECT
      qp.id,
      qp.patient_id,
      qp.token_number,
      qp.status,
      u.name AS patient_name,
      u.profile_image AS patient_profile_image,
      pp.phone,
      b.time::text AS booking_time,
      qp.is_walkin,
      qp.started_at::text AS started_at,
      qp.completed_at::text AS completed_at,
      qp.missed_at::text AS missed_at
    FROM queue_patients qp
    LEFT JOIN users u ON u.id = qp.patient_id
    LEFT JOIN patient_profiles pp ON pp.user_id = qp.patient_id
    LEFT JOIN bookings b
      ON b.patient_id = qp.patient_id
     AND b.session_id = qp.session_id
    WHERE qp.queue_id = $1
    ORDER BY qp.token_number ASC
    `,
    [queueId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    patientId: row.patient_id,
    tokenNumber: row.token_number,
    status: normalizeQueueStatus(row.status),
    patientName: row.patient_name || "Patient",
    profileImage: row.patient_profile_image || null,
    phone: row.phone,
    bookingTime: row.booking_time ? String(row.booking_time).slice(0, 5) : null,
    isWalkIn: Boolean(row.is_walkin),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    missedAt: row.missed_at,
  }));
};

const resolveSessionForMedicalCenter = async (medicalCenterId: string, sessionId: number) => {
  const result = await pool.query<{
    session_id: number;
    doctor_id: number;
    doctor_name: string | null;
    doctor_profile_image: string | null;
    specialty: string | null;
    start_time: string;
    end_time: string;
  }>(
    `
    SELECT
      s.id AS session_id,
      d.id AS doctor_id,
      u.name AS doctor_name,
      u.profile_image AS doctor_profile_image,
      d.specialization AS specialty,
      s.start_time::text AS start_time,
      s.end_time::text AS end_time
    FROM medical_center_doctor_schedule s
    JOIN doctors d ON d.id = s.doctor_profile_id
    JOIN users u ON u.id = d.user_id
    WHERE s.id = $1
      AND s.medical_center_id = $2
      AND s.date = ${APP_DATE_SQL}
      AND s.is_active = TRUE
    LIMIT 1
    `,
    [sessionId, medicalCenterId]
  );

  return result.rows[0] ?? null;
};

export const getReceptionPermissionsData = async (userId: number, medicalCenterId: string) =>
  toReceptionistPermissionContract(await getReceptionistPermissionsByUserId(userId, medicalCenterId));

export const getReceptionDashboardData = async (medicalCenterId: string) => {
  const queue = await loadQueuePayload(medicalCenterId);
  const [clinicResult, statsResult] = await Promise.all([
    pool.query<{ id: string; name: string }>(
      `
      SELECT id, name
      FROM medical_centers
      WHERE id = $1
      LIMIT 1
      `,
      [medicalCenterId]
    ),
    pool.query<{
      total_patients: number;
      today_appointments: number;
      missed_today: number;
      in_queue: number;
    }>(
      `
      SELECT
        COALESCE((
          SELECT COUNT(DISTINCT b.patient_id)::int
          FROM bookings b
          WHERE b.medical_center_id = $1
        ), 0) AS total_patients,
        COALESCE((
          SELECT COUNT(*)::int
          FROM bookings b
          WHERE b.medical_center_id = $1
            AND b.date = ${APP_DATE_SQL}
        ), 0) AS today_appointments,
        COALESCE((
          SELECT COUNT(*)::int
          FROM bookings b
          WHERE b.medical_center_id = $1
            AND b.date = ${APP_DATE_SQL}
            AND COALESCE(UPPER(b.status), '${BOOKING_STATUS.BOOKED}') = '${BOOKING_STATUS.MISSED}'
        ), 0) AS missed_today,
        COALESCE((
          SELECT COUNT(*)::int
          FROM queue_patients qp
          JOIN queues q ON q.id = qp.queue_id
          WHERE q.medical_center_id = $1
            AND q.shift_date = ${APP_DATE_SQL}
            AND qp.status IN ('WAITING', 'WITH_DOCTOR')
        ), 0) AS in_queue
      `,
      [medicalCenterId]
    ),
  ]);

  const stats = statsResult.rows[0];
  return {
    clinic: clinicResult.rows[0] ?? { id: medicalCenterId, name: "Clinic" },
    activeSession: queue.session,
    queue: {
      waitingCount: queue.waitingCount,
      currentPatient: queue.currentPatient,
      averageWaitMinutes: queue.averageWaitMinutes,
    },
    waitingCount: queue.waitingCount,
    currentPatient: queue.currentPatient,
    nextPatient: queue.nextPatient,
    stats: {
      totalPatients: Number(stats?.total_patients ?? 0),
      todayAppointments: Number(stats?.today_appointments ?? 0),
      missedToday: Number(stats?.missed_today ?? 0),
      inQueue: Number(stats?.in_queue ?? 0),
    },
  };
};

export const getReceptionQueueData = async (medicalCenterId: string) => {
  const [clinicResult, rows] = await Promise.all([
    pool.query<{ id: string; name: string }>(
      `
      SELECT id, name
      FROM medical_centers
      WHERE id = $1
      LIMIT 1
      `,
      [medicalCenterId]
    ),
    getQueueDashboardRows(medicalCenterId),
  ]);

  const cards = rows.map(buildQueueCard);
  const liveQueues = cards.filter((card) => card.queueStatus === "LIVE");
  const upcomingQueues = cards.filter(
    (card) =>
      card.queueStatus === "WAITING" ||
      card.queueStatus === "PAUSED" ||
      card.queueStatus === "IDLE"
  );
  const endedQueues = cards.filter((card) => card.queueStatus === "COMPLETED");

  return {
    clinic: clinicResult.rows[0] ?? { id: medicalCenterId, name: "Clinic" },
    date: new Date().toISOString().slice(0, 10),
    summary: {
      activeQueues: liveQueues.length,
      waitingPatients: cards.reduce((sum, card) => sum + card.waitingCount, 0),
      withDoctor: cards.reduce((sum, card) => sum + card.withDoctorCount, 0),
      completedToday: cards.reduce((sum, card) => sum + card.completedCount, 0),
    },
    liveQueues,
    upcomingQueues,
    completedQueues: endedQueues,
    endedQueues,
    allQueues: cards,
  };
};

export const getReceptionQueueDetailData = async (input: {
  medicalCenterId: string;
  queueId?: number | null;
  sessionId?: number | null;
}) => {
  const requestedSessionId = input.sessionId ? Number(input.sessionId) : null;
  let queue =
    input.queueId && Number(input.queueId) > 0
      ? await resolveQueueByIdentifier(input)
      : requestedSessionId
        ? await resolveQueueByIdentifier({
            medicalCenterId: input.medicalCenterId,
            sessionId: requestedSessionId,
          }).catch(() => null)
        : null;

  const sessionId = queue?.schedule_id
    ? Number(queue.schedule_id)
    : requestedSessionId && Number.isFinite(requestedSessionId) && requestedSessionId > 0
      ? requestedSessionId
      : null;

  if (!sessionId) {
    throw createStatusError("Queue session not found", 404);
  }

  const [clinicResult, session] = await Promise.all([
    pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM medical_centers WHERE id = $1 LIMIT 1`,
      [input.medicalCenterId]
    ),
    resolveSessionForMedicalCenter(input.medicalCenterId, sessionId),
  ]);

  if (!session) {
    throw createStatusError("Session not found", 404);
  }

  const preferredQueueResult = await pool.query<QueueRow>(
    `
    SELECT id, doctor_id, schedule_id, status, started_at
    FROM queues
    WHERE schedule_id = $1
      AND medical_center_id = $2
      AND shift_date = ${APP_DATE_SQL}
    ORDER BY
      CASE
        WHEN status IN ('LIVE', 'PAUSED') THEN 0
        WHEN status = 'ENDED' THEN 2
        ELSE 1
      END,
      created_at DESC
    LIMIT 1
    `,
    [session.session_id, input.medicalCenterId]
  );

  if (!queue && preferredQueueResult.rows[0]) {
    queue = preferredQueueResult.rows[0];
  }

  const patients = queue?.id ? await loadQueuePatientsByQueueId(queue.id) : [];

  const card = buildQueueCard({
    session_id: session.session_id,
    doctor_id: session.doctor_id,
    doctor_name: session.doctor_name,
    doctor_profile_image: session.doctor_profile_image,
    specialty: session.specialty,
    medical_center_id: input.medicalCenterId,
    session_date: new Date().toISOString().slice(0, 10),
    start_time: session.start_time,
    end_time: session.end_time,
    queue_id: queue?.id ?? null,
    queue_status: queue?.status ?? null,
    current_token:
      patients.find((patient) => patient.status === "WITH_DOCTOR")?.tokenNumber ?? null,
    current_patient_name:
      patients.find((patient) => patient.status === "WITH_DOCTOR")?.patientName ?? null,
    next_token: patients.find((patient) => patient.status === "WAITING")?.tokenNumber ?? null,
    next_patient_name:
      patients.find((patient) => patient.status === "WAITING")?.patientName ?? null,
    waiting_count: patients.filter((patient) => patient.status === "WAITING").length,
    with_doctor_count: patients.filter((patient) => patient.status === "WITH_DOCTOR").length,
    completed_count: patients.filter((patient) => patient.status === "COMPLETED").length,
    missed_count: patients.filter((patient) => patient.status === "MISSED").length,
    avg_wait_minutes: 0,
  });

  return {
    clinic: clinicResult.rows[0] ?? { id: input.medicalCenterId, name: "Clinic" },
    queue: card,
    currentPatient: patients.find((patient) => patient.status === "WITH_DOCTOR") ?? null,
    nextPatient: patients.find((patient) => patient.status === "WAITING") ?? null,
    waitingPatients: patients.filter((patient) => patient.status === "WAITING"),
    withDoctorPatients: patients.filter((patient) => patient.status === "WITH_DOCTOR"),
    missedPatients: patients.filter((patient) => patient.status === "MISSED"),
    completedPatients: patients.filter((patient) => patient.status === "COMPLETED"),
  };
};

export const getReceptionAppointmentsData = async (
  medicalCenterId: string,
  filters?: { date?: string | null; status?: string | null }
) => {
  const [appointmentsResult, sessionsResult] = await Promise.all([
    pool.query<AppointmentRow>(
      `
      SELECT
        b.id,
        b.session_id,
        u.name AS patient_name,
        du.name AS doctor_name,
        b.date::text AS date,
        b.time::text AS time,
        COALESCE(UPPER(b.status), '${BOOKING_STATUS.BOOKED}') AS status
      FROM bookings b
      LEFT JOIN users u ON u.id = b.patient_id
      LEFT JOIN doctors d ON d.id = b.doctor_id
      LEFT JOIN users du ON du.id = d.user_id
      WHERE b.medical_center_id = $1
        AND ($2::date IS NULL OR b.date = $2::date)
        AND ($3::text IS NULL OR COALESCE(UPPER(b.status), '${BOOKING_STATUS.BOOKED}') = $3::text)
      ORDER BY b.date DESC, b.time ASC, b.id DESC
      `,
      [
        medicalCenterId,
        filters?.date?.trim() ? filters.date.trim() : null,
        filters?.status?.trim() ? filters.status.trim().toUpperCase() : null,
      ]
    ),
    pool.query<AppointmentSessionRow>(
      `
      SELECT
        s.id,
        s.date::text AS date,
        s.start_time::text AS start_time,
        s.end_time::text AS end_time,
        COALESCE(s.slot_duration, 0)::int AS slot_duration,
        COALESCE(s.max_patients, 0)::int AS max_patients,
        s.doctor_profile_id AS doctor_id,
        u.name AS doctor_name,
        d.specialization AS specialty,
        q.id AS queue_id,
        q.status AS queue_status
      FROM medical_center_doctor_schedule s
      LEFT JOIN doctors d ON d.id = s.doctor_profile_id
      LEFT JOIN users u ON u.id = d.user_id
      LEFT JOIN LATERAL (
        SELECT id, status
        FROM queues
        WHERE schedule_id = s.id
          AND medical_center_id = s.medical_center_id
          AND shift_date = s.date
        ORDER BY
          CASE WHEN status IN ('LIVE', 'PAUSED') THEN 0 ELSE 1 END,
          created_at DESC
        LIMIT 1
      ) q ON TRUE
      WHERE s.medical_center_id = $1
        AND s.is_active = TRUE
        AND s.date >= ${APP_DATE_SQL}
      ORDER BY s.date ASC, s.start_time ASC
      `,
      [medicalCenterId]
    ),
  ]);

  return {
    appointments: appointmentsResult.rows,
    sessions: sessionsResult.rows,
  };
};

export const getReceptionVisitsData = async (
  medicalCenterId: string,
  filters?: {
    filter?: string | null;
    date?: string | null;
    search?: string | null;
    doctorId?: number | null;
    sessionId?: number | null;
    page?: number | null;
    limit?: number | null;
  }
) => {
  const normalizedFilter = String(filters?.filter || "today").trim().toLowerCase();
  const searchTerm = String(filters?.search || "").trim();
  const page = Math.max(1, Number(filters?.page || 1));
  const limit = Math.min(100, Math.max(1, Number(filters?.limit || 25)));
  const offset = (page - 1) * limit;

  const visitRowsResult = await pool.query<ReceptionVisitRow>(
    `
    SELECT
      b.id AS booking_id,
      b.patient_id,
      patient_user.name AS patient_name,
      patient_profile.phone AS patient_phone,
      patient_user.email AS patient_email,
      b.doctor_id,
      doctor_user.name AS doctor_name,
      d.specialization AS specialty,
      b.medical_center_id AS clinic_id,
      mc.name AS clinic_name,
      b.session_id,
      b.date::text AS session_date,
      s.start_time::text AS start_time,
      s.end_time::text AS end_time,
      b.time::text AS appointment_time,
      COALESCE(UPPER(b.status), '${BOOKING_STATUS.BOOKED}') AS booking_status,
      qp.token_number,
      qp.status AS queue_patient_status,
      qp.queue_id,
      q.status AS queue_status,
      b.created_at::text AS created_at,
      NULL::text AS created_by_role
    FROM bookings b
    JOIN users patient_user ON patient_user.id = b.patient_id
    LEFT JOIN patient_profiles patient_profile ON patient_profile.user_id = b.patient_id
    LEFT JOIN doctors d ON d.id = b.doctor_id
    LEFT JOIN users doctor_user ON doctor_user.id = d.user_id
    LEFT JOIN medical_centers mc ON mc.id = b.medical_center_id
    LEFT JOIN medical_center_doctor_schedule s ON s.id = b.session_id
    LEFT JOIN queue_patients qp
      ON qp.session_id = b.session_id
     AND qp.patient_id = b.patient_id
    LEFT JOIN queues q ON q.id = qp.queue_id
    WHERE b.medical_center_id = $1
      AND ($2::date IS NULL OR b.date = $2::date)
      AND ($3::int IS NULL OR b.doctor_id = $3)
      AND ($4::int IS NULL OR b.session_id = $4)
      AND (
        $5::text IS NULL
        OR patient_user.name ILIKE '%' || $5::text || '%'
        OR COALESCE(patient_profile.phone, '') ILIKE '%' || $5::text || '%'
        OR COALESCE(doctor_user.name, '') ILIKE '%' || $5::text || '%'
      )
    ORDER BY b.date ASC, b.time ASC, b.id DESC
    LIMIT $6 OFFSET $7
    `,
    [
      medicalCenterId,
      filters?.date?.trim() ? filters.date.trim() : null,
      filters?.doctorId ? Number(filters.doctorId) : null,
      filters?.sessionId ? Number(filters.sessionId) : null,
      searchTerm || null,
      limit,
      offset,
    ]
  );

  const sessionsResult = await pool.query<AppointmentSessionRow & { doctor_id: number; specialty: string | null }>(
    `
    SELECT
      s.id,
      s.date::text AS date,
      s.start_time::text AS start_time,
      s.end_time::text AS end_time,
      COALESCE(s.slot_duration, 0)::int AS slot_duration,
      COALESCE(s.max_patients, 0)::int AS max_patients,
      u.name AS doctor_name,
      s.doctor_profile_id AS doctor_id,
      d.specialization AS specialty,
      mc.name AS clinic_name,
      q.id AS queue_id,
      q.status AS queue_status
    FROM medical_center_doctor_schedule s
    LEFT JOIN doctors d ON d.id = s.doctor_profile_id
    LEFT JOIN users u ON u.id = d.user_id
    LEFT JOIN medical_centers mc ON mc.id = s.medical_center_id
    LEFT JOIN queues q
      ON q.schedule_id = s.id
     AND q.medical_center_id = s.medical_center_id
     AND q.shift_date = ${APP_DATE_SQL}
    WHERE s.medical_center_id = $1
      AND s.is_active = TRUE
      AND s.date >= ${APP_DATE_SQL}
    ORDER BY s.date ASC, s.start_time ASC
    `,
    [medicalCenterId]
  );

  const rawVisits = visitRowsResult.rows.map((row) => ({
    appointmentId: row.booking_id,
    bookingId: row.booking_id,
    patientId: row.patient_id,
    patientName: row.patient_name || "Patient",
    patientPhone: row.patient_phone,
    doctorId: row.doctor_id,
    doctorName: row.doctor_name || "Doctor",
    specialty: row.specialty || "General Physician",
    clinicId: row.clinic_id,
    clinicName: row.clinic_name || "Clinic",
    sessionId: row.session_id,
    sessionDate: row.session_date,
    startTime: row.start_time ? String(row.start_time).slice(0, 5) : null,
    endTime: row.end_time ? String(row.end_time).slice(0, 5) : null,
    appointmentTime: String(row.appointment_time || "").slice(0, 5),
    tokenNumber: row.token_number,
    visitStatus: resolveReceptionVisitStatus(row),
    bookingSource: resolveBookingSource(row.created_by_role, row.patient_email),
    createdAt: row.created_at,
    queueId: row.queue_id,
    queueStatus: row.queue_status ? normalizeQueueStatus(row.queue_status) : null,
  }));

  const visits = rawVisits.filter((visit) => {
    if (normalizedFilter === "all") return true;
    if (normalizedFilter === "today") {
      return visit.sessionDate === new Date().toISOString().slice(0, 10);
    }
    if (normalizedFilter === "upcoming") {
      return (
        visit.sessionDate >= new Date().toISOString().slice(0, 10) &&
        ["booked", "checked_in", "waiting", "with_doctor"].includes(visit.visitStatus)
      );
    }
    return visit.visitStatus === normalizedFilter;
  });

  const doctorsMap = new Map<number, { doctorId: number; doctorName: string; specialty: string | null }>();
  for (const visit of rawVisits) {
    doctorsMap.set(visit.doctorId, {
      doctorId: visit.doctorId,
      doctorName: visit.doctorName,
      specialty: visit.specialty,
    });
  }
  for (const session of sessionsResult.rows) {
    doctorsMap.set(session.doctor_id, {
      doctorId: session.doctor_id,
      doctorName: session.doctor_name || "Doctor",
      specialty: session.specialty,
    });
  }

  const summary = {
    todaysVisits: rawVisits.filter((visit) => visit.sessionDate === new Date().toISOString().slice(0, 10)).length,
    checkedIn: rawVisits.filter((visit) => visit.visitStatus === "checked_in").length,
    waiting: rawVisits.filter((visit) => visit.visitStatus === "waiting").length,
    completed: rawVisits.filter((visit) => visit.visitStatus === "completed").length,
  };

  return {
    visits,
    summary,
    doctors: Array.from(doctorsMap.values()).sort((a, b) => a.doctorName.localeCompare(b.doctorName)),
    sessions: sessionsResult.rows.map((session) => ({
      id: session.id,
      doctorId: session.doctor_id,
      doctorName: session.doctor_name || "Doctor",
      specialty: session.specialty || "General Physician",
      clinicName: session.clinic_name || "Clinic",
      date: session.date,
      startTime: String(session.start_time || "").slice(0, 5),
      endTime: String(session.end_time || "").slice(0, 5),
      slotDuration: session.slot_duration,
      maxPatients: session.max_patients,
      queueId: session.queue_id ?? null,
      queueStatus: session.queue_status ? normalizeQueueStatus(session.queue_status) : null,
    })),
    pagination: {
      page,
      limit,
      count: visits.length,
    },
  };
};

export const getReceptionVisitDetailData = async (medicalCenterId: string, visitId: number) => {
  const data = await getReceptionVisitsData(medicalCenterId, { filter: "all", page: 1, limit: 500 });
  const visit = data.visits.find((item) => item.bookingId === visitId);
  if (!visit) {
    throw createStatusError("Visit not found", 404);
  }

  const actionAvailability = {
    canCheckIn: visit.visitStatus === "booked",
    canSendToQueue: visit.visitStatus === "checked_in",
    canComplete: ["checked_in", "waiting", "with_doctor"].includes(visit.visitStatus),
    canMarkMissed: ["booked", "checked_in", "waiting", "with_doctor"].includes(visit.visitStatus),
    canCancel: ["booked", "checked_in"].includes(visit.visitStatus),
  };

  return {
    visit,
    patient: {
      id: visit.patientId,
      name: visit.patientName,
      phone: visit.patientPhone,
    },
    appointment: {
      id: visit.bookingId,
      date: visit.sessionDate,
      time: visit.appointmentTime,
      status: visit.visitStatus,
      bookingSource: visit.bookingSource,
      createdAt: visit.createdAt,
    },
    session: {
      id: visit.sessionId,
      clinicId: visit.clinicId,
      clinicName: visit.clinicName,
      startTime: visit.startTime,
      endTime: visit.endTime,
      queueId: visit.queueId,
      queueStatus: visit.queueStatus,
      tokenNumber: visit.tokenNumber,
    },
    doctor: {
      id: visit.doctorId,
      name: visit.doctorName,
      specialty: visit.specialty,
    },
    actionAvailability,
  };
};

export const createReceptionAppointment = async (input: {
  medicalCenterId: string;
  sessionId: number;
  time: string;
  patientId?: number | null;
  patientName?: string | null;
  phone?: string | null;
}) => {
  const sessionId = ensureValidSessionId(input.sessionId);
  const bookingTime = String(input.time || "").trim();
  if (!bookingTime) {
    throw createStatusError("Booking time is required", 400);
  }
  const sessionResult = await pool.query<{
    id: number;
    medical_center_id: string;
    doctor_profile_id: number;
  }>(
    `
    SELECT id, medical_center_id, doctor_profile_id
    FROM medical_center_doctor_schedule
    WHERE id = $1
      AND medical_center_id = $2
      AND is_active = TRUE
    LIMIT 1
    `,
    [sessionId, input.medicalCenterId]
  );

  const session = sessionResult.rows[0];
  if (!session) {
    throw createStatusError("Session not found", 404);
  }

  let patientId = Number(input.patientId);
  if (!Number.isFinite(patientId) || patientId <= 0) {
    const patientName = String(input.patientName || "").trim();
    if (!patientName) {
      throw createStatusError("Patient name is required", 400);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const createdUser = await client.query<{ id: number }>(
        `
        INSERT INTO users (name, email, password, password_hash, is_password_set, role)
        VALUES ($1, $2, NULL, NULL, FALSE, 'patient')
        RETURNING id
        `,
        [patientName, createWalkInEmail(patientName)]
      );
      patientId = createdUser.rows[0].id;
      await client.query(
        `
        INSERT INTO patient_profiles (user_id, phone, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET
          phone = COALESCE(EXCLUDED.phone, patient_profiles.phone),
          updated_at = NOW()
        `,
        [patientId, input.phone?.trim() || null]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const booking = await bookUnifiedSession(session.id, patientId, bookingTime);
  return mutationResponse("Appointment booked successfully", { appointment: booking });
};

const requireReceptionBooking = async (medicalCenterId: string, bookingId: number) => {
  const result = await pool.query<{
    id: number;
    patient_id: number;
    doctor_id: number;
    medical_center_id: string;
    session_id: number | null;
    date: string;
    time: string;
    status: string;
  }>(
    `
    SELECT
      id,
      patient_id,
      doctor_id,
      medical_center_id,
      session_id,
      date::text AS date,
      time::text AS time,
      COALESCE(UPPER(status), '${BOOKING_STATUS.BOOKED}') AS status
    FROM bookings
    WHERE id = $1
      AND medical_center_id = $2
    LIMIT 1
    `,
    [bookingId, medicalCenterId]
  );

  const booking = result.rows[0];
  if (!booking) {
    throw createStatusError("Visit not found", 404);
  }

  return booking;
};

const requireReceptionBookingForUpdate = async (
  client: PoolClient,
  medicalCenterId: string,
  bookingId: number
) => {
  const result = await client.query<{
    id: number;
    patient_id: number;
    doctor_id: number;
    medical_center_id: string;
    session_id: number | null;
    date: string;
    time: string;
    status: string;
    scheduled_at: string | null;
    grace_period_minutes: number | null;
  }>(
    `
    SELECT
      id,
      patient_id,
      doctor_id,
      medical_center_id,
      session_id,
      date::text AS date,
      time::text AS time,
      COALESCE(UPPER(status), '${BOOKING_STATUS.BOOKED}') AS status,
      ${BOOKING_SCHEDULED_AT_SQL}::text AS scheduled_at,
      grace_period_minutes
    FROM bookings
    WHERE id = $1
      AND medical_center_id = $2
    LIMIT 1
    FOR UPDATE
    `,
    [bookingId, medicalCenterId]
  );

  const booking = result.rows[0];
  if (!booking) {
    throw createStatusError("Appointment not found", 404, "APPOINTMENT_NOT_FOUND");
  }

  return booking;
};

export const checkInReceptionVisit = async (medicalCenterId: string, bookingId: number) => {
  const eventPayload = await withTransaction(async (client) => {
    const booking = await requireReceptionBookingForUpdate(client, medicalCenterId, bookingId);
    if (String(booking.date || "").slice(0, 10) !== getTodayDateKey()) {
      throw createStatusError("Only today's appointments can be checked in.", 400, "SESSION_NOT_TODAY");
    }
    if (booking.status === BOOKING_STATUS.CANCELLED) {
      throw createStatusError("Cancelled appointments cannot be checked in.", 400, "APPOINTMENT_CANCELLED");
    }
    if (booking.status === BOOKING_STATUS.COMPLETED) {
      throw createStatusError("Completed appointments cannot be checked in.", 400, "APPOINTMENT_COMPLETED");
    }
    if (booking.status === BOOKING_STATUS.MISSED) {
      throw createStatusError("Missed appointments cannot be checked in.", 400, "APPOINTMENT_MISSED");
    }
    if (booking.status === BOOKING_STATUS.CONFIRMED || booking.status === BOOKING_STATUS.IN_PROGRESS) {
      throw createStatusError("Patient is already checked in.", 409, "ALREADY_CHECKED_IN");
    }

    const lateness = await client.query<{ late_minutes: number }>(
      `
      SELECT GREATEST(
        FLOOR(EXTRACT(EPOCH FROM (${BOOKING_NOW_SQL} - ${BOOKING_SCHEDULED_AT_SQL})) / 60),
        0
      )::int AS late_minutes
      FROM bookings
      WHERE id = $1
      `,
      [booking.id]
    );
    const lateMinutes = Number(lateness.rows[0]?.late_minutes || 0);
    const threshold = Number(booking.grace_period_minutes || DEFAULT_BOOKING_GRACE_PERIOD_MINUTES);
    const isLate = lateMinutes > threshold;

    if (isLate && LATE_CHECK_IN_ACTION === "mark_missed") {
      await client.query(
        `
        UPDATE bookings
        SET status = '${BOOKING_STATUS.MISSED}',
            missed_at = COALESCE(missed_at, NOW())
        WHERE id = $1
        `,
        [booking.id]
      );

      const missedQueueRows = booking.session_id
        ? await client.query<{
            queue_id: number;
            doctor_id: number;
            schedule_id: number | null;
            patient_id: number | null;
          }>(
          `
          UPDATE queue_patients qp
          SET status = 'MISSED',
              missed_at = COALESCE(qp.missed_at, NOW())
          FROM queues q
          WHERE qp.queue_id = q.id
            AND q.medical_center_id = $1
            AND qp.session_id = $2
            AND qp.patient_id = $3
            AND qp.status IN ('WAITING', 'WITH_DOCTOR')
          RETURNING qp.queue_id, q.doctor_id, q.schedule_id, qp.patient_id
          `,
          [medicalCenterId, booking.session_id, booking.patient_id]
        )
        : { rows: [] };

      for (const row of missedQueueRows.rows) {
        await renumberQueue(client, row.queue_id);
      }

      return mutationResponse("Patient marked missed because they arrived after the grace period", {
        bookingId: booking.id,
        status: "missed",
        lateMinutes,
        gracePeriodMinutes: threshold,
        missedQueueRows: missedQueueRows.rows,
      });
    }

    await client.query(
      `
      UPDATE bookings
      SET status = '${BOOKING_STATUS.CONFIRMED}',
          started_at = COALESCE(started_at, NOW())
      WHERE id = $1
      `,
      [booking.id]
    );

    if (!booking.session_id) {
      return mutationResponse(
        isLate ? "Patient checked in late" : "Patient checked in successfully",
        {
          bookingId: booking.id,
          status: "checked_in",
          lateMinutes,
          gracePeriodMinutes: threshold,
          queue: null,
        }
      );
    }

    const queue = await resolveQueueForUpdate(client, {
      medicalCenterId,
      sessionId: booking.session_id,
    });

    if (!queue || !["LIVE", "PAUSED"].includes(normalizeQueueStatus(queue.status))) {
      return mutationResponse("Patient checked in. Start the queue to place them in the live queue.", {
        bookingId: booking.id,
        status: "checked_in",
        lateMinutes,
        gracePeriodMinutes: threshold,
        sessionId: booking.session_id,
        queue: null,
      });
    }

    const existing = await client.query<{
      id: number;
      token_number: number;
      status: string;
      checked_in_at: string | null;
    }>(
      `
      SELECT id, token_number, status, checked_in_at::text AS checked_in_at
      FROM queue_patients
      WHERE queue_id = $1
        AND patient_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [queue.id, booking.patient_id]
    );

    if (existing.rows[0]?.id) {
      if (existing.rows[0].checked_in_at) {
        throw createStatusError("Patient is already checked in.", 409, "ALREADY_CHECKED_IN");
      }
      const nextPosition = isLate ? await getEndPosition(client, queue.id) : existing.rows[0].token_number;
      await client.query(
        `
        UPDATE queue_patients
        SET status = 'WAITING',
            checked_in_at = COALESCE(checked_in_at, NOW()),
            token_number = $2
        WHERE id = $1
        `,
        [existing.rows[0].id, nextPosition]
      );
      await renumberQueue(client, queue.id);
      const patient = await getQueuePatientSummary(client, existing.rows[0].id);
      return mutationResponse(
        isLate ? "Patient marked late and moved to end of queue" : "Patient checked in successfully",
        {
        bookingId: booking.id,
        queueId: queue.id,
        sessionId: booking.session_id,
        position: patient?.token_number ?? existing.rows[0].token_number,
        patient,
        doctorId: queue.doctor_id,
        lateMinutes,
        gracePeriodMinutes: threshold,
        }
      );
    }

    const position = isLate ? await getEndPosition(client, queue.id) : await getEndPosition(client, queue.id);
    const inserted = await insertQueuePatientAtPosition(client, {
      queueId: queue.id,
      doctorId: booking.doctor_id,
      patientId: booking.patient_id,
      medicalCenterId,
      sessionId: booking.session_id,
      position,
      isWalkIn: false,
      priority: "normal",
    });
    const patient = await getQueuePatientSummary(client, inserted.id);

    return mutationResponse(
      isLate ? "Patient marked late and moved to end of queue" : "Patient checked in and added to queue",
      {
        bookingId: booking.id,
        queueId: queue.id,
        sessionId: booking.session_id,
        position: patient?.token_number ?? inserted.token_number,
        patient,
        doctorId: queue.doctor_id,
        lateMinutes,
        gracePeriodMinutes: threshold,
      }
    );
  });

  const data = eventPayload.data as {
    queueId?: number;
    sessionId?: number | null;
    patient?: QueuePatientSummaryRow | null;
    doctorId?: number;
    missedQueueRows?: Array<{
      queue_id: number;
      doctor_id: number;
      schedule_id: number | null;
      patient_id: number | null;
    }>;
  };
  for (const row of data.missedQueueRows || []) {
    emitPatientMissed({
      queueId: row.queue_id,
      sessionId: row.schedule_id,
      doctorId: row.doctor_id,
      patientId: row.patient_id,
      medicalCenterId,
    });
  }
  if (data.queueId && data.patient) {
    emitQueueUpdate({
      type: "PATIENT_CHECKED_IN",
      queueId: data.queueId,
      sessionId: data.sessionId,
      patientId: data.patient.patient_id,
      doctorId: data.doctorId,
      medicalCenterId,
      patient: data.patient,
    });
  }
  return eventPayload;
};

export const markReceptionVisitMissed = async (medicalCenterId: string, bookingId: number) => {
  const result = await withTransaction(async (client) => {
    const booking = await requireReceptionBookingForUpdate(client, medicalCenterId, bookingId);
    if (String(booking.date || "").slice(0, 10) !== getTodayDateKey()) {
      throw createStatusError("Only today's appointments can be marked missed.", 400, "SESSION_NOT_TODAY");
    }
    if (booking.status === BOOKING_STATUS.CANCELLED) {
      throw createStatusError("Cancelled appointments cannot be marked missed.", 400, "APPOINTMENT_CANCELLED");
    }
    if (booking.status === BOOKING_STATUS.COMPLETED) {
      throw createStatusError("Completed appointments cannot be marked missed.", 400, "APPOINTMENT_COMPLETED");
    }
    if (booking.status === BOOKING_STATUS.MISSED) {
      throw createStatusError("This appointment is already marked missed.", 409, "APPOINTMENT_MISSED");
    }

    await client.query(
      `
      UPDATE bookings
      SET status = '${BOOKING_STATUS.MISSED}',
          missed_at = COALESCE(missed_at, NOW())
      WHERE id = $1
      `,
      [booking.id]
    );

    const missedQueueRows = booking.session_id
      ? await client.query<{
          queue_id: number;
          doctor_id: number;
          schedule_id: number | null;
          patient_id: number | null;
        }>(
          `
          UPDATE queue_patients qp
          SET status = 'MISSED',
              missed_at = COALESCE(qp.missed_at, NOW())
          FROM queues q
          WHERE qp.queue_id = q.id
            AND q.medical_center_id = $1
            AND qp.session_id = $2
            AND qp.patient_id = $3
            AND qp.status IN ('WAITING', 'WITH_DOCTOR')
          RETURNING qp.queue_id, q.doctor_id, q.schedule_id, qp.patient_id
          `,
          [medicalCenterId, booking.session_id, booking.patient_id]
        )
      : { rows: [] };

    for (const row of missedQueueRows.rows) {
      await renumberQueue(client, row.queue_id);
    }

    return mutationResponse("Visit marked as missed", {
      bookingId: booking.id,
      status: "missed",
      missedQueueRows: missedQueueRows.rows,
    });
  });

  for (const row of result.data.missedQueueRows) {
    emitPatientMissed({
      queueId: row.queue_id,
      sessionId: row.schedule_id,
      doctorId: row.doctor_id,
      patientId: row.patient_id,
      medicalCenterId,
    });
  }

  return result;
};

export const cancelReceptionVisit = async (medicalCenterId: string, bookingId: number) => {
  const result = await withTransaction(async (client) => {
    const booking = await requireReceptionBookingForUpdate(client, medicalCenterId, bookingId);
    if (
      booking.status === BOOKING_STATUS.CANCELLED ||
      booking.status === BOOKING_STATUS.COMPLETED ||
      booking.status === BOOKING_STATUS.MISSED
    ) {
      throw createStatusError("This visit cannot be cancelled", 400);
    }

    const activeQueueRows = booking.session_id
      ? await client.query<{ id: number; queue_id: number; status: string }>(
          `
          SELECT qp.id, qp.queue_id, qp.status
          FROM queue_patients qp
          JOIN queues q ON q.id = qp.queue_id
          WHERE q.medical_center_id = $1
            AND qp.session_id = $2
            AND qp.patient_id = $3
            AND qp.status IN ('WAITING', 'WITH_DOCTOR')
          FOR UPDATE OF qp
          `,
          [medicalCenterId, booking.session_id, booking.patient_id]
        )
      : { rows: [] };

    if (activeQueueRows.rows.some((row) => row.status === "WITH_DOCTOR")) {
      throw createStatusError("Cannot cancel a patient who is currently with the doctor", 409);
    }

    await client.query(
      `
      UPDATE bookings
      SET status = '${BOOKING_STATUS.CANCELLED}'
      WHERE id = $1
      `,
      [booking.id]
    );

    const removedQueueRows: Array<{ queue_id: number }> = [];
    for (const row of activeQueueRows.rows) {
      await client.query(`DELETE FROM queue_patients WHERE id = $1`, [row.id]);
      await renumberQueue(client, row.queue_id);
      removedQueueRows.push({ queue_id: row.queue_id });
    }

    return mutationResponse("Visit cancelled successfully", {
      bookingId: booking.id,
      status: "cancelled",
      removedQueueRows,
    });
  });

  for (const row of result.data.removedQueueRows) {
    emitQueueUpdate({
      type: "PATIENT_REMOVED",
      queueId: row.queue_id,
      medicalCenterId,
    });
  }

  return result;
};

export const completeReceptionVisit = async (medicalCenterId: string, bookingId: number) => {
  const result = await withTransaction(async (client) => {
    const booking = await requireReceptionBookingForUpdate(client, medicalCenterId, bookingId);
    if (
      booking.status === BOOKING_STATUS.CANCELLED ||
      booking.status === BOOKING_STATUS.COMPLETED ||
      booking.status === BOOKING_STATUS.MISSED
    ) {
      throw createStatusError("This visit cannot be completed", 400);
    }

    await client.query(
      `
      UPDATE bookings
      SET status = '${BOOKING_STATUS.COMPLETED}',
          started_at = COALESCE(started_at, NOW()),
          ended_at = COALESCE(ended_at, NOW())
      WHERE id = $1
      `,
      [booking.id]
    );

    const completedQueueRows = booking.session_id
      ? await client.query<{ queue_id: number; doctor_id: number; schedule_id: number | null }>(
          `
          UPDATE queue_patients qp
          SET status = 'COMPLETED',
              completed_at = COALESCE(qp.completed_at, NOW())
          FROM queues q
          WHERE qp.queue_id = q.id
            AND q.medical_center_id = $1
            AND qp.session_id = $2
            AND qp.patient_id = $3
            AND qp.status IN ('WAITING', 'WITH_DOCTOR')
          RETURNING qp.queue_id, q.doctor_id, q.schedule_id
          `,
          [medicalCenterId, booking.session_id, booking.patient_id]
        )
      : { rows: [] };

    for (const row of completedQueueRows.rows) {
      await renumberQueue(client, row.queue_id);
    }

    return mutationResponse("Visit completed successfully", {
      bookingId: booking.id,
      status: "completed",
      completedQueueRows: completedQueueRows.rows,
    });
  });

  for (const row of result.data.completedQueueRows) {
    emitQueueUpdate({
      type: "PATIENT_COMPLETED",
      queueId: row.queue_id,
      sessionId: row.schedule_id,
      doctorId: row.doctor_id,
      medicalCenterId,
    });
  }

  return result;
};

export const sendReceptionVisitToQueue = async (medicalCenterId: string, bookingId: number) => {
  const result = await withTransaction(async (client) => {
    const booking = await requireReceptionBookingForUpdate(client, medicalCenterId, bookingId);
    if (!booking.session_id) {
      throw createStatusError("Visit is not linked to a clinic session", 400, "SESSION_REQUIRED");
    }
    if (
      booking.status === BOOKING_STATUS.CANCELLED ||
      booking.status === BOOKING_STATUS.COMPLETED ||
      booking.status === BOOKING_STATUS.MISSED
    ) {
      throw createStatusError("This visit cannot be sent to queue", 400, "INVALID_APPOINTMENT_STATUS");
    }

    const queue = await requireLiveQueueForUpdate(client, {
      medicalCenterId,
      sessionId: booking.session_id,
    });

    const existing = await client.query<{
      id: number;
      status: string;
      token_number: number | null;
      checked_in_at: string | null;
    }>(
      `
      SELECT id, status, token_number, checked_in_at::text AS checked_in_at
      FROM queue_patients
      WHERE queue_id = $1
        AND patient_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [queue.id, booking.patient_id]
    );

    if (existing.rows[0]?.id) {
      if (["COMPLETED", "MISSED"].includes(normalizeQueueStatus(existing.rows[0].status))) {
        throw createStatusError("Patient already has a closed queue record for this session", 409, "QUEUE_ENTRY_CLOSED");
      }

      await client.query(
        `
        UPDATE queue_patients
        SET status = 'WAITING',
            checked_in_at = COALESCE(checked_in_at, NOW())
        WHERE id = $1
        `,
        [existing.rows[0].id]
      );
      await client.query(
        `
        UPDATE bookings
        SET status = '${BOOKING_STATUS.CONFIRMED}',
            started_at = COALESCE(started_at, NOW())
        WHERE id = $1
        `,
        [booking.id]
      );
      const patient = await getQueuePatientSummary(client, existing.rows[0].id);
      return mutationResponse("Patient is already linked to this queue", {
        bookingId: booking.id,
        queueId: queue.id,
        sessionId: booking.session_id,
        position: patient?.token_number ?? existing.rows[0].token_number,
        patient,
        doctorId: queue.doctor_id,
      });
    }

    const inserted = await insertQueuePatientAtPosition(client, {
      queueId: queue.id,
      doctorId: queue.doctor_id,
      patientId: booking.patient_id,
      medicalCenterId,
      sessionId: booking.session_id,
      position: await getEndPosition(client, queue.id),
      isWalkIn: false,
      priority: "normal",
    });

    await client.query(
      `
      UPDATE bookings
      SET status = '${BOOKING_STATUS.CONFIRMED}',
          started_at = COALESCE(started_at, NOW())
      WHERE id = $1
      `,
      [booking.id]
    );

    const patient = await getQueuePatientSummary(client, inserted.id);
    return mutationResponse("Patient sent to queue successfully", {
      bookingId: booking.id,
      queueId: queue.id,
      sessionId: booking.session_id,
      position: patient?.token_number ?? inserted.token_number,
      patient,
      doctorId: queue.doctor_id,
    });
  });

  emitQueueUpdate({
    type: "PATIENT_ADDED",
    queueId: result.data.queueId,
    sessionId: result.data.sessionId,
    patientId: result.data.patient?.patient_id,
    doctorId: result.data.doctorId,
    medicalCenterId,
    patient: result.data.patient,
  });

  return result;
};

export const updateReceptionAppointmentStatus = async (input: {
  medicalCenterId: string;
  appointmentId: number;
  status: string;
}) => {
  const appointmentId = Number(input.appointmentId);
  if (!Number.isFinite(appointmentId) || appointmentId <= 0) {
    throw createStatusError("Invalid appointment id", 400);
  }

  const status = ensureValidAppointmentStatus(input.status);
  const result = await pool.query(
    `
    UPDATE bookings
    SET status = $1,
        started_at = CASE
          WHEN $1 = '${BOOKING_STATUS.CONFIRMED}' THEN started_at
          WHEN $1 = '${BOOKING_STATUS.COMPLETED}' THEN COALESCE(started_at, NOW())
          ELSE started_at
        END,
        ended_at = CASE
          WHEN $1 = '${BOOKING_STATUS.COMPLETED}' THEN COALESCE(ended_at, NOW())
          ELSE ended_at
        END,
        missed_at = CASE
          WHEN $1 = '${BOOKING_STATUS.MISSED}' THEN COALESCE(missed_at, NOW())
          ELSE missed_at
        END
    WHERE id = $2
      AND medical_center_id = $3
    RETURNING id, status
    `,
    [status, appointmentId, input.medicalCenterId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Appointment not found", 404);
  }

  return {
    message: "Appointment updated successfully",
    id: appointmentId,
    status,
  };
};

export const listReceptionPatientsData = async (medicalCenterId: string) => {
  const result = await pool.query<PatientListRow>(
    `
    SELECT
      u.id,
      u.name,
      pp.phone,
      MAX(b.date::text) AS last_visit,
      BOOL_OR(b.date = ${APP_DATE_SQL}) AS is_recent
    FROM bookings b
    JOIN users u ON u.id = b.patient_id
    LEFT JOIN patient_profiles pp ON pp.user_id = u.id
    WHERE b.medical_center_id = $1
    GROUP BY u.id, u.name, pp.phone
    ORDER BY MAX(b.date) DESC NULLS LAST, u.name ASC
    `,
    [medicalCenterId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name || "Patient",
    phone: row.phone,
    last_visit: row.last_visit,
    is_recent: Boolean(row.is_recent),
  }));
};

export const registerReceptionPatientData = async (input: {
  medicalCenterId: string;
  name: string;
  phone?: string | null;
  sessionId?: number | null;
  addToQueue?: boolean;
}) => {
  const name = String(input.name || "").trim();
  if (!name) {
    throw createStatusError("Patient name is required", 400);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const createdUser = await client.query<{ id: number }>(
      `
      INSERT INTO users (name, email, password, password_hash, is_password_set, role)
      VALUES ($1, $2, NULL, NULL, FALSE, 'patient')
      RETURNING id
      `,
      [name, createWalkInEmail(name)]
    );

    const patientId = createdUser.rows[0].id;
    await client.query(
      `
      INSERT INTO patient_profiles (user_id, phone, updated_at)
      VALUES ($1, $2, NOW())
      `,
      [patientId, input.phone?.trim() || null]
    );

    let queue: Record<string, unknown> | null = null;

    if (input.sessionId && Number(input.sessionId) > 0) {
      const sessionResult = await client.query<{
        id: number;
        medical_center_id: string;
      }>(
        `
        SELECT id, medical_center_id
        FROM medical_center_doctor_schedule
        WHERE id = $1
          AND medical_center_id = $2
          AND is_active = TRUE
        LIMIT 1
        `,
        [Number(input.sessionId), input.medicalCenterId]
      );

      if (sessionResult.rows.length === 0) {
        throw createStatusError("Session not found", 404);
      }

      if (input.addToQueue) {
        const queueRecord = await requireQueue(input.medicalCenterId, Number(input.sessionId));
        await ensureQueuePatientUserForeignKey(client);
        const tokenResult = await client.query<{ next_token: number }>(
          `
          SELECT COALESCE(MAX(token_number), 0)::int + 1 AS next_token
          FROM queue_patients
          WHERE queue_id = $1
          `,
          [queueRecord.id]
        );

        const queueInsert = await client.query<{ id: number; token_number: number }>(
          `
          INSERT INTO queue_patients (
            queue_id,
            doctor_id,
            patient_id,
            token_number,
            status,
            medical_center_id
          )
          VALUES ($1, $2, $3, $4, 'WAITING', $5)
          RETURNING id, token_number
          `,
          [
            queueRecord.id,
            queueRecord.doctor_id,
            patientId,
            tokenResult.rows[0]?.next_token ?? 1,
            input.medicalCenterId,
          ]
        );

        queue = queueInsert.rows[0];
      }
    }

    await client.query("COMMIT");

    return {
      patient: { id: patientId, name, phone: input.phone?.trim() || null },
      queue,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const addReceptionWalkInToQueue = async (input: {
  medicalCenterId: string;
  name: string;
  phone?: string | null;
  priority?: string | null;
  queueId?: number | null;
  sessionId?: number | null;
}) => {
  const name = String(input.name || "").trim();
  if (!name) {
    throw createStatusError("Patient name is required", 400, "PATIENT_NAME_REQUIRED");
  }
  const priority = normalizePriority(input.priority);

  const result = await withTransaction(async (client) => {
    const queue = await requireLiveQueueForUpdate(client, {
      medicalCenterId: input.medicalCenterId,
      queueId: input.queueId,
      sessionId: input.sessionId,
    });

    const createdUser = await client.query<{ id: number }>(
      `
      INSERT INTO users (name, email, password, password_hash, is_password_set, role)
      VALUES ($1, $2, NULL, NULL, FALSE, 'patient')
      RETURNING id
      `,
      [name, createWalkInEmail(name)]
    );

    const patientId = createdUser.rows[0].id;
    await client.query(
      `
      INSERT INTO patient_profiles (user_id, phone, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        phone = COALESCE(EXCLUDED.phone, patient_profiles.phone),
        updated_at = NOW()
      `,
      [patientId, input.phone?.trim() || null]
    );
    await ensureQueuePatientUserForeignKey(client);

    const position =
      priority === "emergency"
        ? 1
        : priority === "urgent"
          ? await getUrgentPosition(client, queue.id)
          : await getEndPosition(client, queue.id);

    const inserted = await insertQueuePatientAtPosition(client, {
      queueId: queue.id,
      doctorId: queue.doctor_id,
      patientId,
      medicalCenterId: input.medicalCenterId,
      sessionId: queue.schedule_id,
      position,
      isWalkIn: true,
      priority,
    });
    const patient = await getQueuePatientSummary(client, inserted.id);

    return mutationResponse("Walk-in patient added to queue", {
      queueId: queue.id,
      sessionId: queue.schedule_id,
      doctorId: queue.doctor_id,
      patient,
      position: patient?.token_number ?? inserted.token_number,
      priority,
    });
  });

  emitQueueUpdate({
    type: "WALK_IN_ADDED",
    queueId: result.data.queueId,
    sessionId: result.data.sessionId,
    doctorId: result.data.doctorId,
    patientId: result.data.patient?.patient_id,
    medicalCenterId: input.medicalCenterId,
    patient: result.data.patient,
  });

  return result;
};

export const moveReceptionQueueToNextPatient = async (
  medicalCenterId: string,
  sessionId?: number | null,
  queueId?: number | null
) => {
  const result = await withTransaction(async (client) => {
    const queue = await requireLiveQueueForUpdate(client, { medicalCenterId, sessionId, queueId });

    const completed = await client.query<{ patient_id: number | null }>(
      `
      UPDATE queue_patients
      SET status = 'COMPLETED',
          completed_at = COALESCE(completed_at, NOW())
      WHERE queue_id = $1
        AND status = 'WITH_DOCTOR'
      RETURNING patient_id
      `,
      [queue.id]
    );

    for (const row of completed.rows) {
      if (!row.patient_id) continue;
      await updateNearestBookingStatus(client, {
        doctorId: Number(queue.doctor_id),
        patientId: Number(row.patient_id),
        nextStatus: BOOKING_STATUS.COMPLETED,
        allowedCurrentStatuses: [
          BOOKING_STATUS.IN_PROGRESS,
          BOOKING_STATUS.CONFIRMED,
          BOOKING_STATUS.BOOKED,
        ],
        setEndedAt: true,
      });
    }

    const nextPatient = await client.query<{ id: number; patient_id: number | null }>(
      `
      SELECT id, patient_id
      FROM queue_patients
      WHERE queue_id = $1
        AND status = 'WAITING'
      ORDER BY token_number ASC, id ASC
      LIMIT 1
      FOR UPDATE
      `,
      [queue.id]
    );

    const row = nextPatient.rows[0];
    if (!row) {
      return mutationResponse("No more patients in queue", {
        queueId: queue.id,
        sessionId: queue.schedule_id,
        doctorId: queue.doctor_id,
        nextPatient: null,
        completedCount: completed.rows.length,
      });
    }

    await client.query(
      `
      UPDATE queue_patients
      SET status = 'WITH_DOCTOR',
          started_at = COALESCE(started_at, NOW())
      WHERE id = $1
      `,
      [row.id]
    );

    if (row.patient_id) {
      await updateNearestBookingStatus(client, {
        doctorId: Number(queue.doctor_id),
        patientId: Number(row.patient_id),
        nextStatus: BOOKING_STATUS.IN_PROGRESS,
        allowedCurrentStatuses: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.BOOKED],
        setStartedAt: true,
      });
    }

    const patient = await getQueuePatientSummary(client, row.id);
    return mutationResponse("Moved to next patient", {
      queueId: queue.id,
      sessionId: queue.schedule_id,
      doctorId: queue.doctor_id,
      nextPatient: patient,
      completedCount: completed.rows.length,
    });
  });

  if (result.data.nextPatient) {
    emitPatientCalled({
      queueId: result.data.queueId,
      sessionId: result.data.sessionId,
      doctorId: result.data.doctorId,
      medicalCenterId,
      patient: result.data.nextPatient,
    });
  } else {
    emitQueueUpdate({
      type: "QUEUE_EMPTY",
      queueId: result.data.queueId,
      sessionId: result.data.sessionId,
      doctorId: result.data.doctorId,
      medicalCenterId,
    });
  }

  return result;
};

export const completeReceptionQueuePatient = async (
  medicalCenterId: string,
  sessionId?: number | null,
  queueId?: number | null
) => {
  const result = await withTransaction(async (client) => {
    const queue = await requireLiveQueueForUpdate(client, { medicalCenterId, sessionId, queueId });

    const completed = await client.query<{ patient_id: number | null }>(
      `
      UPDATE queue_patients
      SET status = 'COMPLETED',
          completed_at = COALESCE(completed_at, NOW())
      WHERE queue_id = $1
        AND status = 'WITH_DOCTOR'
      RETURNING patient_id
      `,
      [queue.id]
    );

    if (completed.rows.length === 0) {
      throw createStatusError("No active patient to complete", 400);
    }

    for (const row of completed.rows) {
      if (!row.patient_id) continue;
      await updateNearestBookingStatus(client, {
        doctorId: Number(queue.doctor_id),
        patientId: Number(row.patient_id),
        nextStatus: BOOKING_STATUS.COMPLETED,
        allowedCurrentStatuses: [
          BOOKING_STATUS.IN_PROGRESS,
          BOOKING_STATUS.CONFIRMED,
          BOOKING_STATUS.BOOKED,
        ],
        setEndedAt: true,
      });
    }

    return mutationResponse("Patient completed", {
      queueId: queue.id,
      sessionId: queue.schedule_id,
      doctorId: queue.doctor_id,
      completedCount: completed.rows.length,
    });
  });

  emitQueueUpdate({
    type: "PATIENT_COMPLETED",
    queueId: result.data.queueId,
    sessionId: result.data.sessionId,
    doctorId: result.data.doctorId,
    medicalCenterId,
  });

  return result;
};

export const missReceptionQueuePatient = async (
  medicalCenterId: string,
  sessionId?: number | null,
  queueId?: number | null
) => {
  const result = await withTransaction(async (client) => {
    const queue = await requireLiveQueueForUpdate(client, { medicalCenterId, sessionId, queueId });

    const missed = await client.query<{ patient_id: number | null }>(
      `
      UPDATE queue_patients
      SET status = 'MISSED',
          missed_at = COALESCE(missed_at, NOW())
      WHERE queue_id = $1
        AND status = 'WITH_DOCTOR'
      RETURNING patient_id
      `,
      [queue.id]
    );

    if (missed.rows.length === 0) {
      throw createStatusError("No active patient to mark missed", 400);
    }

    for (const row of missed.rows) {
      if (!row.patient_id) continue;
      await updateNearestBookingStatus(client, {
        doctorId: Number(queue.doctor_id),
        patientId: Number(row.patient_id),
        nextStatus: BOOKING_STATUS.MISSED,
        allowedCurrentStatuses: [
          BOOKING_STATUS.IN_PROGRESS,
          BOOKING_STATUS.CONFIRMED,
          BOOKING_STATUS.BOOKED,
        ],
      });
    }

    return mutationResponse("Patient marked missed", {
      queueId: queue.id,
      sessionId: queue.schedule_id,
      doctorId: queue.doctor_id,
      missedPatients: missed.rows,
    });
  });

  for (const row of result.data.missedPatients) {
    emitPatientMissed({
      queueId: result.data.queueId,
      sessionId: result.data.sessionId,
      doctorId: result.data.doctorId,
      patientId: row.patient_id,
      medicalCenterId,
    });
  }

  return result;
};

export const startReceptionQueue = async (input: {
  medicalCenterId: string;
  sessionId: number;
}) => {
  const sessionId = ensureValidSessionId(input.sessionId);
  const result = await withTransaction(async (client) => {
    await markMissedBookings(client);

    const sessionResult = await client.query<{
      id: number;
      medical_center_id: string;
      doctor_profile_id: number;
    }>(
      `
      SELECT id, medical_center_id, doctor_profile_id
      FROM medical_center_doctor_schedule
      WHERE id = $1
        AND medical_center_id = $2
        AND date = ${APP_DATE_SQL}
        AND is_active = TRUE
      LIMIT 1
      FOR UPDATE
      `,
      [sessionId, input.medicalCenterId]
    );

    const session = sessionResult.rows[0];
    if (!session) {
      throw createStatusError("Today's clinic session was not found", 404, "SESSION_NOT_FOUND");
    }

    const activeQueueResult = await client.query<QueueRow>(
      `
      SELECT id, doctor_id, schedule_id, status, started_at
      FROM queues
      WHERE doctor_id = $1
        AND medical_center_id = $2
        AND shift_date = ${APP_DATE_SQL}
        AND status IN ('LIVE', 'PAUSED')
      LIMIT 1
      FOR UPDATE
      `,
      [session.doctor_profile_id, input.medicalCenterId]
    );

    if (activeQueueResult.rows[0]?.id) {
      throw createStatusError("This doctor already has an active queue today", 409, "SESSION_ALREADY_LIVE");
    }

    const endedQueueResult = await client.query<QueueRow>(
      `
      SELECT id, doctor_id, schedule_id, status, started_at
      FROM queues
      WHERE schedule_id = $1
        AND medical_center_id = $2
        AND shift_date = ${APP_DATE_SQL}
        AND status = 'ENDED'
      LIMIT 1
      FOR UPDATE
      `,
      [session.id, input.medicalCenterId]
    );

    if (endedQueueResult.rows[0]?.id) {
      throw createStatusError("Today's queue has already ended for this session", 409, "SESSION_ALREADY_ENDED");
    }

    const queueResult = await client.query<{ id: number }>(
      `
      INSERT INTO queues (doctor_id, status, shift_id, schedule_id, shift_date, medical_center_id, started_at)
      VALUES ($1, 'LIVE', NULL, $2, ${APP_DATE_SQL}, $3, NOW())
      RETURNING id
      `,
      [session.doctor_profile_id, session.id, input.medicalCenterId]
    );

    const queueId = queueResult.rows[0].id;

    const insertedPatients = await client.query<QueuePatientSummaryRow>(
      `
      WITH todays_bookings AS (
        SELECT
          b.patient_id,
          ROW_NUMBER() OVER (ORDER BY b.time ASC, b.id ASC) AS token_number
        FROM bookings b
        WHERE b.doctor_id = $2
          AND b.medical_center_id = $4
          AND b.session_id = $3
          AND b.date = ${APP_DATE_SQL}
          AND COALESCE(UPPER(b.status), '${BOOKING_STATUS.BOOKED}') IN (
            '${BOOKING_STATUS.BOOKED}',
            '${BOOKING_STATUS.CONFIRMED}'
          )
      ),
      inserted AS (
        INSERT INTO queue_patients (
          queue_id,
          doctor_id,
          patient_id,
          token_number,
          status,
          medical_center_id,
          session_id,
          is_walkin,
          priority
        )
        SELECT
          $1,
          $2,
          tb.patient_id,
          tb.token_number,
          'WAITING',
          $4,
          $3,
          FALSE,
          'normal'
        FROM todays_bookings tb
        WHERE NOT EXISTS (
          SELECT 1
          FROM queue_patients qp
          WHERE qp.session_id = $3
            AND qp.patient_id = tb.patient_id
        )
        RETURNING id, queue_id, patient_id, token_number, status, priority, is_walkin
      )
      SELECT
        inserted.*,
        COALESCE(u.name, 'Patient') AS patient_name
      FROM inserted
      LEFT JOIN users u ON u.id = inserted.patient_id
      ORDER BY inserted.token_number ASC
      `,
      [queueId, session.doctor_profile_id, session.id, input.medicalCenterId]
    );

    return mutationResponse("Queue started successfully", {
      queueId,
      sessionId: session.id,
      doctorId: session.doctor_profile_id,
      status: "active",
      positions: insertedPatients.rows.map((row) => ({
        queuePatientId: row.id,
        patientId: row.patient_id,
        patientName: row.patient_name || "Patient",
        position: row.token_number,
        status: row.status,
      })),
    });
  });

  emitQueueUpdate({
    type: "QUEUE_STARTED",
    queueId: result.data.queueId,
    sessionId: result.data.sessionId,
    doctorId: result.data.doctorId,
    medicalCenterId: input.medicalCenterId,
  });

  return result;
};

export const pauseReceptionQueue = async (input: {
  medicalCenterId: string;
  queueId?: number | null;
  sessionId?: number | null;
}) => {
  const queue = await resolveQueueByIdentifier(input);
  if (!queue) {
    throw createStatusError("Queue not found", 404);
  }
  if (normalizeQueueStatus(queue.status) !== "LIVE") {
    throw createStatusError("Queue is not live", 400);
  }
  await pool.query(`UPDATE queues SET status = 'PAUSED' WHERE id = $1`, [queue.id]);
  emitQueueUpdate({
    type: "QUEUE_PAUSED",
    queueId: queue.id,
    sessionId: queue.schedule_id,
    doctorId: queue.doctor_id,
    medicalCenterId: input.medicalCenterId,
  });
  return mutationResponse("Queue paused successfully", {
    queueId: queue.id,
    sessionId: queue.schedule_id,
    doctorId: queue.doctor_id,
    status: "paused",
  });
};

export const resumeReceptionQueue = async (input: {
  medicalCenterId: string;
  queueId?: number | null;
  sessionId?: number | null;
}) => {
  const queue = await resolveQueueByIdentifier(input);
  if (!queue) {
    throw createStatusError("Queue not found", 404);
  }
  if (normalizeQueueStatus(queue.status) !== "PAUSED") {
    throw createStatusError("Queue is not paused", 400);
  }
  await pool.query(`UPDATE queues SET status = 'LIVE' WHERE id = $1`, [queue.id]);
  emitQueueUpdate({
    type: "QUEUE_RESUMED",
    queueId: queue.id,
    sessionId: queue.schedule_id,
    doctorId: queue.doctor_id,
    medicalCenterId: input.medicalCenterId,
  });
  return mutationResponse("Queue resumed successfully", {
    queueId: queue.id,
    sessionId: queue.schedule_id,
    doctorId: queue.doctor_id,
    status: "active",
  });
};

export const endReceptionQueue = async (input: {
  medicalCenterId: string;
  queueId?: number | null;
  sessionId?: number | null;
}) => {
  const result = await withTransaction(async (client) => {
    const queue = await requireLiveQueueForUpdate(client, input);

    const activeConsultationPatients = await client.query<{ patient_id: number | null }>(
      `
      SELECT qp.patient_id
      FROM queue_patients qp
      LEFT JOIN consultations c ON c.id = qp.consultation_id
      WHERE qp.queue_id = $1
        AND qp.status = 'WITH_DOCTOR'
        AND COALESCE(UPPER(c.status), '') IN ('ACTIVE', 'IN_PROGRESS')
      FOR UPDATE
      `,
      [queue.id]
    );

    if (activeConsultationPatients.rows.length > 0) {
      throw createStatusError(
        "Complete the active consultation before ending the queue.",
        409,
        "ACTIVE_CONSULTATION_EXISTS"
      );
    }

    const completedPatients = await client.query<{ patient_id: number | null }>(
      `
      UPDATE queue_patients qp
      SET status = 'COMPLETED',
          completed_at = COALESCE(qp.completed_at, NOW())
      WHERE qp.queue_id = $1
        AND qp.status = 'WITH_DOCTOR'
        AND EXISTS (
          SELECT 1
          FROM consultations c
          WHERE c.id = qp.consultation_id
            AND COALESCE(UPPER(c.status), '') = 'COMPLETED'
        )
      RETURNING patient_id
      `,
      [queue.id]
    );

    for (const row of completedPatients.rows) {
      if (!row.patient_id) continue;
      await updateNearestBookingStatus(client, {
        doctorId: Number(queue.doctor_id),
        patientId: Number(row.patient_id),
        nextStatus: BOOKING_STATUS.COMPLETED,
        allowedCurrentStatuses: [
          BOOKING_STATUS.IN_PROGRESS,
          BOOKING_STATUS.CONFIRMED,
          BOOKING_STATUS.BOOKED,
        ],
        setEndedAt: true,
      });
    }

    const calledPatients = await client.query<{ patient_id: number | null }>(
      `
      UPDATE queue_patients qp
      SET status = 'MISSED',
          missed_at = COALESCE(qp.missed_at, NOW())
      WHERE qp.queue_id = $1
        AND qp.status = 'WITH_DOCTOR'
        AND (
          qp.consultation_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM consultations c
            WHERE c.id = qp.consultation_id
              AND COALESCE(UPPER(c.status), '') IN ('ACTIVE', 'IN_PROGRESS', 'COMPLETED')
          )
        )
      RETURNING patient_id
      `,
      [queue.id]
    );

    for (const row of calledPatients.rows) {
      if (!row.patient_id) continue;
      await updateNearestBookingStatus(client, {
        doctorId: Number(queue.doctor_id),
        patientId: Number(row.patient_id),
        nextStatus: BOOKING_STATUS.MISSED,
        allowedCurrentStatuses: [
          BOOKING_STATUS.IN_PROGRESS,
          BOOKING_STATUS.CONFIRMED,
          BOOKING_STATUS.BOOKED,
        ],
      });
    }

    const missedPatients = await client.query<{ patient_id: number | null }>(
      `
      UPDATE queue_patients
      SET status = 'MISSED',
          missed_at = COALESCE(missed_at, NOW())
      WHERE queue_id = $1
        AND status = 'WAITING'
      RETURNING patient_id
      `,
      [queue.id]
    );

    for (const row of missedPatients.rows) {
      if (!row.patient_id) continue;
      await updateNearestBookingStatus(client, {
        doctorId: Number(queue.doctor_id),
        patientId: Number(row.patient_id),
        nextStatus: BOOKING_STATUS.MISSED,
        allowedCurrentStatuses: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.BOOKED],
      });
    }

    const unattendedBookings = queue.schedule_id
      ? await client.query<{ patient_id: number | null }>(
          `
          UPDATE bookings
          SET status = '${BOOKING_STATUS.MISSED}',
              missed_at = COALESCE(missed_at, NOW())
          WHERE medical_center_id = $1
            AND session_id = $2
            AND date = ${APP_DATE_SQL}
            AND COALESCE(UPPER(status), '${BOOKING_STATUS.BOOKED}') IN ('${BOOKING_STATUS.BOOKED}', '${BOOKING_STATUS.CONFIRMED}')
          RETURNING patient_id
          `,
          [input.medicalCenterId, queue.schedule_id]
        )
      : { rows: [] as Array<{ patient_id: number | null }> };

    await client.query(
      `
      UPDATE queues
      SET status = 'ENDED',
          ended_at = COALESCE(ended_at, NOW())
      WHERE id = $1
      `,
      [queue.id]
    );

    return mutationResponse("Queue ended successfully", {
      queueId: queue.id,
      sessionId: queue.schedule_id,
      doctorId: queue.doctor_id,
      completedPatients: completedPatients.rows,
      completedCount: completedPatients.rows.length,
      calledMissedPatients: calledPatients.rows,
      missedPatients: missedPatients.rows,
      unattendedBookings: unattendedBookings.rows,
      missedCount: calledPatients.rows.length + missedPatients.rows.length + unattendedBookings.rows.length,
      status: "ended",
    });
  });

  for (const row of result.data.calledMissedPatients) {
    emitPatientMissed({
      queueId: result.data.queueId,
      sessionId: result.data.sessionId,
      doctorId: result.data.doctorId,
      patientId: row.patient_id,
      medicalCenterId: input.medicalCenterId,
    });
  }

  for (const row of result.data.completedPatients) {
    if (!row.patient_id) continue;
    emitQueueUpdate({
      type: "QUEUE_ENDED",
      queueId: result.data.queueId,
      sessionId: result.data.sessionId,
      doctorId: result.data.doctorId,
      patientId: row.patient_id,
      medicalCenterId: input.medicalCenterId,
    });
  }

  for (const row of result.data.missedPatients) {
    emitPatientMissed({
      queueId: result.data.queueId,
      sessionId: result.data.sessionId,
      doctorId: result.data.doctorId,
      patientId: row.patient_id,
      medicalCenterId: input.medicalCenterId,
    });
  }

  for (const row of result.data.unattendedBookings) {
    if (!row.patient_id) continue;
    emitQueueUpdate({
      type: "QUEUE_ENDED",
      queueId: result.data.queueId,
      sessionId: result.data.sessionId,
      doctorId: result.data.doctorId,
      patientId: row.patient_id,
      medicalCenterId: input.medicalCenterId,
    });
  }

  emitQueueUpdate({
    type: "QUEUE_ENDED",
    queueId: result.data.queueId,
    sessionId: result.data.sessionId,
    doctorId: result.data.doctorId,
    medicalCenterId: input.medicalCenterId,
  });

  return result;
};
