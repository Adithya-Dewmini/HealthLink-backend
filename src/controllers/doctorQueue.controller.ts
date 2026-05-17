import type { Response } from "express";
import type { PoolClient } from "pg";
import pool from "../config/db";
import { io } from "../server";
import { filterExpoTokens, sendExpoPush } from "../utils/expoPush";
import { BOOKING_STATUS, updateNearestBookingStatus } from "../utils/bookingLifecycle";
import type { AuthenticatedRequest } from "../types/auth";
import {
  doctorQueueSql,
  getLatestQueueForDoctorToday,
  getLiveQueueForDoctorToday,
  requireDoctorIdForUser,
  resolveStartableSchedule,
} from "../services/doctorQueue.service";
import { emitClinicPublicQueueUpdate } from "../services/clinicRealtime.service";
import { SOCKET_EVENTS, logRealtimeEmit } from "../services/realtime.service";

type QueueStartBody = {
  scheduleId?: number | string | null;
};

type EndQueueBody = {
  force?: boolean | null;
};

type AddPatientBody = {
  patient_id?: number | string | null;
  complaint?: string;
  name?: string;
};

type CallPatientBody = {
  queuePatientId?: number | string | null;
};

type DoctorQueueRequest<TBody = Record<string, unknown>> = AuthenticatedRequest<TBody>;
type HttpError = Error & { statusCode?: number };

type QueueRow = {
  id: number;
  doctor_id: number;
  status: string;
  shift_id: number | null;
  schedule_id?: number | null;
  shift_date: string;
  medical_center_id: string | null;
};

type QueuePatientRow = {
  id: number;
  patient_id: number;
  token_number: number;
  consultation_id: number | null;
  status?: string;
};

const { APP_DATE_SQL } = doctorQueueSql;
const doctorRoom = (doctorId: number | string) => `doctor_${doctorId}`;
const legacyDoctorRoom = (doctorId: number | string) => `doctor-${doctorId}`;
const patientRoom = (patientId: number | string) => `patient_${patientId}`;
const receptionRoom = "reception";

const getDoctorUserId = (req: DoctorQueueRequest) => {
  if (!req.user?.id) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  if (req.user.role !== "doctor") {
    throw Object.assign(new Error("Only doctors can access this resource"), {
      statusCode: 403,
    });
  }

  return req.user.id;
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;

  return res.status(statusCode).json({
    message: appError?.message || fallbackMessage,
  });
};

const broadcastQueueUpdate = (
  doctorId: number | string,
  payload: {
    queueId: number;
    type: string;
    triggeredBy?: string;
    patientId?: number | string;
    medicalCenterId?: string | null;
    sessionId?: number | null;
  }
) => {
  const enrichedPayload = { ...payload, doctorId };
  for (const room of [doctorRoom(doctorId), legacyDoctorRoom(doctorId), receptionRoom]) {
    io.to(room).emit(SOCKET_EVENTS.queueUpdate, enrichedPayload);
    logRealtimeEmit(SOCKET_EVENTS.queueUpdate, room, enrichedPayload);
  }

  if (payload.patientId) {
    const room = patientRoom(payload.patientId);
    io.to(room).emit(SOCKET_EVENTS.queueUpdate, enrichedPayload);
    logRealtimeEmit(SOCKET_EVENTS.queueUpdate, room, enrichedPayload);
  }
  if (payload.medicalCenterId) {
    emitClinicPublicQueueUpdate({
      clinicId: payload.medicalCenterId,
      doctorId,
      queueId: payload.queueId,
      sessionId: payload.sessionId ?? null,
      type: payload.type,
    });
  }
};

const notifyQueuePatients = async (
  queueId: number,
  callback: (patientId: number) => void | Promise<void>,
  db: PoolClient | typeof pool = pool
) => {
  const patientIdsResult = await db.query<{ patient_id: number | null }>(
    `SELECT DISTINCT patient_id FROM queue_patients WHERE queue_id = $1`,
    [queueId]
  );

  for (const row of patientIdsResult.rows) {
    if (!row.patient_id) {
      continue;
    }

    await callback(row.patient_id);
  }
};

const loadDoctorTokens = async (doctorId: number) => {
  const tokenResult = await pool.query<{ expo_push_token: string | null }>(
    `SELECT expo_push_token FROM doctors WHERE id = $1`,
    [doctorId]
  );

  return filterExpoTokens(tokenResult.rows.map((row) => row.expo_push_token));
};

const activateQueuePatientForDoctor = async (
  client: PoolClient,
  input: {
    queue: QueueRow;
    doctorProfileId: number;
    doctorUserId: number;
    queuePatientId?: number | string | null;
  }
) => {
  const activePatientResult = await client.query<QueuePatientRow>(
    `
    SELECT *
    FROM queue_patients
    WHERE queue_id = $1
      AND status = 'WITH_DOCTOR'
    ORDER BY started_at DESC NULLS LAST, token_number ASC
    LIMIT 1
    FOR UPDATE
    `,
    [input.queue.id]
  );

  if (activePatientResult.rows[0]) {
    throw Object.assign(
      new Error("Finish or skip the current patient before calling the next patient"),
      {
        statusCode: 409,
      }
    );
  }

  const nextPatientResult = input.queuePatientId
    ? await client.query<QueuePatientRow>(
        `
        SELECT *
        FROM queue_patients
        WHERE queue_id = $1
          AND id = $2
          AND status = 'WAITING'
        LIMIT 1
        FOR UPDATE
        `,
        [input.queue.id, input.queuePatientId]
      )
    : await client.query<QueuePatientRow>(
        `
        SELECT *
        FROM queue_patients
        WHERE queue_id = $1
          AND status = 'WAITING'
        ORDER BY token_number ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
        `,
        [input.queue.id]
      );

  const nextPatient = nextPatientResult.rows[0];
  if (!nextPatient) {
    throw Object.assign(
      new Error(
        input.queuePatientId ? "Selected patient is no longer waiting in this queue" : "No patients waiting yet"
      ),
      {
        statusCode: input.queuePatientId ? 404 : 409,
      }
    );
  }

  const updatedPatientResult = await client.query<QueuePatientRow>(
    `
    UPDATE queue_patients
    SET status = 'WITH_DOCTOR',
        started_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [nextPatient.id]
  );

  await updateNearestBookingStatus(client, {
    doctorId: Number(input.doctorProfileId),
    patientId: Number(nextPatient.patient_id),
    nextStatus: BOOKING_STATUS.IN_PROGRESS,
    allowedCurrentStatuses: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.BOOKED],
    setStartedAt: true,
  });

  let consultationId = nextPatient.consultation_id ?? null;
  if (!consultationId) {
    const consultationResult = await client.query<{ id: number }>(
      `
      INSERT INTO consultations
        (patient_id, doctor_id, queue_id, symptoms, diagnosis, notes, medicines, medical_center_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
      `,
      [
        nextPatient.patient_id,
        input.doctorUserId,
        input.queue.id,
        null,
        null,
        null,
        JSON.stringify([]),
        input.queue.medical_center_id ?? null,
      ]
    );

    consultationId = consultationResult.rows[0]?.id ?? null;

    if (consultationId) {
      await client.query(
        `
        UPDATE queue_patients
        SET consultation_id = $1
        WHERE id = $2
        `,
        [consultationId, nextPatient.id]
      );
    }
  }

  return {
    patient: updatedPatientResult.rows[0],
    consultationId,
  };
};

export const startQueue = async (
  req: DoctorQueueRequest<QueueStartBody>,
  res: Response
) => {
  try {
    const userId = getDoctorUserId(req);
    const requestedScheduleId = req.body?.scheduleId ?? null;
    const doctorId = await requireDoctorIdForUser(userId);
    const activeSchedule = await resolveStartableSchedule(doctorId, requestedScheduleId);

    if (!activeSchedule) {
      return res.status(400).json({ message: "No active session found for this time" });
    }

    const activeQueuesResult = await pool.query<{ id: number }>(
      `
      SELECT id
      FROM queues
      WHERE doctor_id = $1
        AND shift_date = ${APP_DATE_SQL}
        AND status IN ('LIVE', 'PAUSED')
        AND (schedule_id IS DISTINCT FROM $2)
      `,
      [doctorId, activeSchedule.id]
    );

    for (const row of activeQueuesResult.rows) {
      const queueIdToEnd = row.id;

      await pool.query(
        `
        UPDATE queue_patients
        SET status = 'COMPLETED',
            completed_at = NOW()
        WHERE queue_id = $1
          AND status = 'WITH_DOCTOR'
        `,
        [queueIdToEnd]
      );

      await pool.query(
        `
        UPDATE queue_patients
        SET status = 'MISSED',
            missed_at = NOW()
        WHERE queue_id = $1
          AND status = 'WAITING'
        `,
        [queueIdToEnd]
      );

      await pool.query(
        `
        UPDATE queues
        SET status = 'ENDED'
        WHERE id = $1
        `,
        [queueIdToEnd]
      );

      broadcastQueueUpdate(doctorId, {
        queueId: queueIdToEnd,
        type: "CLINIC_ENDED",
        triggeredBy: req.user?.role,
        medicalCenterId: activeSchedule.medical_center_id,
        sessionId: activeSchedule.id,
      });

      try {
        await notifyQueuePatients(queueIdToEnd, async (patientId) => {
          broadcastQueueUpdate(doctorId, {
            queueId: queueIdToEnd,
            type: "CLINIC_ENDED",
            triggeredBy: req.user?.role,
            patientId,
            medicalCenterId: activeSchedule.medical_center_id,
            sessionId: activeSchedule.id,
          });
        });
      } catch (error) {
        console.error("Queue cleanup notify error:", error);
      }
    }

    const todayQueueResult = await pool.query<QueueRow>(
      `
      SELECT *
      FROM queues
      WHERE doctor_id = $1
        AND shift_date = ${APP_DATE_SQL}
        AND schedule_id = $2
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [doctorId, activeSchedule.id]
    );

    const existingQueue = todayQueueResult.rows[0];
    if (existingQueue) {
      if (existingQueue.status === "LIVE" || existingQueue.status === "PAUSED") {
        return res.status(409).json({ message: "Queue already started", queue: existingQueue });
      }

      if (existingQueue.status === "ENDED") {
        return res.status(409).json({ message: "Today's clinic has already ended" });
      }
    }

    let newQueueResult;
    try {
      newQueueResult = await pool.query<QueueRow>(
        `
        INSERT INTO queues (doctor_id, status, shift_id, schedule_id, shift_date, medical_center_id)
        VALUES ($1, 'LIVE', NULL, $2, ${APP_DATE_SQL}, $3)
        RETURNING *
        `,
        [doctorId, activeSchedule.id, activeSchedule.medical_center_id]
      );
    } catch (error) {
      const appError = error as { code?: string };
      if (appError?.code === "23505") {
        return res.json({
          message: "This session's queue has already ended",
        });
      }

      throw error;
    }

    const newQueue = newQueueResult.rows[0];
    await pool.query(
      `
      INSERT INTO queue_patients (queue_id, doctor_id, patient_id, token_number, status, medical_center_id)
      SELECT
        $1,
        $2,
        b.patient_id,
        ROW_NUMBER() OVER (ORDER BY b.time ASC),
        'WAITING',
        $4
      FROM bookings b
      WHERE b.doctor_id = $2
        AND b.medical_center_id = $4
        AND b.session_id = $3
        AND b.date = ${APP_DATE_SQL}
        AND NOT EXISTS (
          SELECT 1
          FROM queue_patients qp
          WHERE qp.queue_id = $1
            AND qp.patient_id = b.patient_id
        )
      `,
      [newQueue.id, doctorId, activeSchedule.id, newQueue.medical_center_id ?? null]
    );

    broadcastQueueUpdate(doctorId, {
      queueId: newQueue.id,
      type: "QUEUE_STARTED",
      triggeredBy: req.user?.role,
      medicalCenterId: newQueue.medical_center_id,
      sessionId: newQueue.schedule_id,
    });

    try {
      await notifyQueuePatients(newQueue.id, async (patientId) => {
        broadcastQueueUpdate(doctorId, {
          queueId: newQueue.id,
          type: "QUEUE_STARTED",
          triggeredBy: req.user?.role,
          patientId,
          medicalCenterId: newQueue.medical_center_id,
          sessionId: newQueue.schedule_id,
        });
      });
    } catch (error) {
      console.error("Queue started room broadcast error:", error);
    }

    try {
      const tokensResult = await pool.query<{ expo_push_token: string | null }>(
        `
        SELECT pp.expo_push_token
        FROM queue_patients qp
        JOIN patient_profiles pp ON pp.user_id = qp.patient_id
        WHERE qp.queue_id = $1
        `,
        [newQueue.id]
      );
      const tokens = filterExpoTokens(tokensResult.rows.map((row) => row.expo_push_token));
      await sendExpoPush(
        tokens.map((token) => ({
          to: token,
          title: "Queue Started",
          body: "Your doctor's queue is now live.",
          data: { queueId: newQueue.id, doctorId },
        }))
      );
    } catch (error) {
      console.error("Queue started push error:", error);
    }

    return res.json({
      message: "Queue started successfully",
      queue: newQueue,
      scheduleId: activeSchedule.id,
    });
  } catch (error) {
    console.error("Start queue error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const pauseQueue = async (req: DoctorQueueRequest, res: Response) => {
  try {
    const userId = getDoctorUserId(req);
    const doctorId = await requireDoctorIdForUser(userId);
    const queue = await getLatestQueueForDoctorToday(doctorId);

    if (!queue) {
      return res.status(404).json({ message: "No active queue found today" });
    }

    const updatedQueueResult = await pool.query<QueueRow>(
      `
      UPDATE queues
      SET status = 'PAUSED'
      WHERE id = $1
      RETURNING *
      `,
      [queue.id]
    );

    const updatedQueue = updatedQueueResult.rows[0];

    broadcastQueueUpdate(doctorId, {
      queueId: updatedQueue.id,
      type: "QUEUE_PAUSED",
      triggeredBy: req.user?.role,
      medicalCenterId: updatedQueue.medical_center_id,
      sessionId: updatedQueue.schedule_id,
    });

    return res.json({
      message: "Queue paused successfully",
      queue: updatedQueue,
    });
  } catch (error) {
    console.error("Pause queue error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const resumeQueue = async (req: DoctorQueueRequest, res: Response) => {
  try {
    const userId = getDoctorUserId(req);
    const doctorId = await requireDoctorIdForUser(userId);
    const queue = await getLatestQueueForDoctorToday(doctorId);

    if (!queue) {
      return res.status(404).json({ message: "No queue found today" });
    }

    if (queue.status !== "PAUSED") {
      return res.status(400).json({ message: "Queue is not paused" });
    }

    const updatedQueueResult = await pool.query<QueueRow>(
      `
      UPDATE queues
      SET status = 'LIVE'
      WHERE id = $1
      RETURNING *
      `,
      [queue.id]
    );

    const updatedQueue = updatedQueueResult.rows[0];

    broadcastQueueUpdate(doctorId, {
      queueId: updatedQueue.id,
      type: "QUEUE_RESUMED",
      triggeredBy: req.user?.role,
      medicalCenterId: updatedQueue.medical_center_id,
      sessionId: updatedQueue.schedule_id,
    });

    return res.json({
      message: "Queue resumed successfully",
      queue: updatedQueue,
    });
  } catch (error) {
    console.error("Resume queue error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const addPatientToQueue = async (
  req: DoctorQueueRequest<AddPatientBody>,
  res: Response
) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userId = getDoctorUserId(req);
    const doctorId = await requireDoctorIdForUser(userId, client);
    const { patient_id, complaint, name } = req.body;
    let patientId = patient_id;

    if (!patientId) {
      const walkInName = name || "Walk-in Patient";
      const walkInEmail = `walkin_${Date.now()}_${Math.floor(Math.random() * 1000)}@walkin.local`;

      const userInsert = await client.query<{ id: number }>(
        `
        INSERT INTO users (name, email, password, role)
        VALUES ($1, $2, $3, 'patient')
        RETURNING id
        `,
        [walkInName, walkInEmail, "walkin"]
      );

      patientId = userInsert.rows[0]?.id ?? null;
    }

    if (!patientId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Patient ID is required" });
    }

    const queueResult = await client.query<QueueRow>(
      `
      SELECT *
      FROM queues
      WHERE doctor_id = $1
        AND shift_date = ${APP_DATE_SQL}
        AND status = 'LIVE'
      FOR UPDATE
      `,
      [doctorId]
    );

    const queue = queueResult.rows[0];
    if (!queue) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "No active LIVE queue found today" });
    }

    const tokenResult = await client.query<{ next_token: number }>(
      `
      SELECT COALESCE(MAX(token_number), 0) + 1 AS next_token
      FROM queue_patients
      WHERE queue_id = $1
      `,
      [queue.id]
    );

    const nextToken = tokenResult.rows[0]?.next_token ?? 1;

    const insertResult = await client.query(
      `
      INSERT INTO queue_patients (queue_id, doctor_id, patient_id, token_number, complaint)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [queue.id, doctorId, patientId, nextToken, complaint || null]
    );

    await client.query("COMMIT");

    broadcastQueueUpdate(doctorId, {
      queueId: queue.id,
      type: "PATIENT_ADDED",
      triggeredBy: req.user?.role,
      medicalCenterId: queue.medical_center_id,
      sessionId: queue.schedule_id,
    });

    return res.json({
      message: "Patient added to queue",
      patient: insertResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Add patient to queue error:", error);
    return handleControllerError(res, error, "Server error");
  } finally {
    client.release();
  }
};

export const moveToNextPatient = async (req: DoctorQueueRequest, res: Response) => {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const userId = getDoctorUserId(req);
    const doctorId = await requireDoctorIdForUser(userId, client);

    const queueResult = await client.query<QueueRow>(
      `
      SELECT *
      FROM queues
      WHERE doctor_id = $1
        AND shift_date = ${APP_DATE_SQL}
        AND status = 'LIVE'
      FOR UPDATE
      `,
      [doctorId]
    );

    const queue = queueResult.rows[0];
    if (!queue) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "No LIVE queue found today" });
    }

    const waitingPatientCount = await client.query<{ id: number }>(
      `
      SELECT id
      FROM queue_patients
      WHERE queue_id = $1
        AND status = 'WAITING'
      LIMIT 1
      `,
      [queue.id]
    );

    if (!waitingPatientCount.rows[0]) {
      await client.query("COMMIT");

      broadcastQueueUpdate(doctorId, {
        queueId: queue.id,
        type: "QUEUE_EMPTY",
        triggeredBy: req.user?.role,
        medicalCenterId: queue.medical_center_id,
        sessionId: queue.schedule_id,
      });

      try {
        const doctorTokens = await loadDoctorTokens(doctorId);
        await sendExpoPush(
          doctorTokens.map((token) => ({
            to: token,
            title: "Queue Empty",
            body: "There are no patients waiting.",
            data: { queueId: queue.id },
          }))
        );
      } catch (error) {
        console.error("Queue empty push error:", error);
      }

      return res.status(409).json({ message: "No patients waiting yet" });
    }

    const activation = await activateQueuePatientForDoctor(client, {
      queue,
      doctorProfileId: doctorId,
      doctorUserId: userId,
    });

    await client.query("COMMIT");
    committed = true;

    try {
      const currentToken = activation.patient?.token_number ?? 0;
      const nearTokenLimit = Number(currentToken) + 2;
      const nearResult = await pool.query<{ expo_push_token: string | null }>(
        `
        SELECT pp.expo_push_token
        FROM queue_patients qp
        JOIN patient_profiles pp ON pp.user_id = qp.patient_id
        WHERE qp.queue_id = $1
          AND qp.status = 'WAITING'
          AND qp.token_number <= $2
        `,
        [queue.id, nearTokenLimit]
      );
      const nearTokens = filterExpoTokens(nearResult.rows.map((row) => row.expo_push_token));
      await sendExpoPush(
        nearTokens.map((token) => ({
          to: token,
          title: "Your Turn Soon",
          body: "Only a couple of patients left before your turn.",
          data: { queueId: queue.id },
        }))
      );
    } catch (error) {
      console.error("Near turn push error:", error);
    }

    broadcastQueueUpdate(doctorId, {
      queueId: queue.id,
      type: "NEXT_PATIENT",
      triggeredBy: req.user?.role,
      medicalCenterId: queue.medical_center_id,
      sessionId: queue.schedule_id,
    });

    try {
      await notifyQueuePatients(queue.id, async (patientId) => {
        broadcastQueueUpdate(doctorId, {
          queueId: queue.id,
          type: "NEXT_PATIENT",
          triggeredBy: req.user?.role,
          patientId,
          medicalCenterId: queue.medical_center_id,
          sessionId: queue.schedule_id,
        });
      });
    } catch (error) {
      console.error("Next patient room broadcast error:", error);
    }

    return res.json({
      message: "Moved to next patient",
      patient: activation.patient,
      consultationId: activation.consultationId,
      queueId: queue.id,
    });
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    console.error("Next patient error:", error);
    return handleControllerError(res, error, "Server error");
  } finally {
    client.release();
  }
};

export const callPatient = async (
  req: DoctorQueueRequest<CallPatientBody>,
  res: Response
) => {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const userId = getDoctorUserId(req);
    const doctorId = await requireDoctorIdForUser(userId, client);
    const queuePatientId = req.body?.queuePatientId ?? null;

    if (!queuePatientId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "queuePatientId is required" });
    }

    const queue = await getLiveQueueForDoctorToday(doctorId, client);

    if (!queue) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "No active LIVE queue found today" });
    }

    const activation = await activateQueuePatientForDoctor(client, {
      queue,
      doctorProfileId: doctorId,
      doctorUserId: userId,
      queuePatientId,
    });

    await client.query("COMMIT");
    committed = true;

    broadcastQueueUpdate(doctorId, {
      queueId: queue.id,
      type: "PATIENT_CALLED",
      triggeredBy: req.user?.role,
      patientId: activation.patient.patient_id,
      medicalCenterId: queue.medical_center_id,
      sessionId: queue.schedule_id,
    });

    return res.json({
      message: "Patient called successfully",
      patient: activation.patient,
      consultationId: activation.consultationId,
      queueId: queue.id,
    });
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    console.error("Call patient error:", error);
    return handleControllerError(res, error, "Server error");
  } finally {
    client.release();
  }
};

export const skipPatient = async (req: DoctorQueueRequest, res: Response) => {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    const userId = getDoctorUserId(req);
    const doctorId = await requireDoctorIdForUser(userId, client);
    const queue = await getLiveQueueForDoctorToday(doctorId, client);

    if (!queue) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "No active queue found today" });
    }

    const skippedResult = await client.query<{ id: number; patient_id: number | null }>(
      `
      UPDATE queue_patients
      SET status = 'MISSED',
          missed_at = NOW()
      WHERE queue_id = $1
        AND status = 'WITH_DOCTOR'
      RETURNING id, patient_id
      `,
      [queue.id]
    );

    if (skippedResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "No active patient to skip" });
    }

    const missedPatientId = skippedResult.rows[0]?.patient_id ?? null;
    if (missedPatientId) {
      await updateNearestBookingStatus(client, {
        doctorId: Number(doctorId),
        patientId: Number(missedPatientId),
        nextStatus: BOOKING_STATUS.MISSED,
        allowedCurrentStatuses: [BOOKING_STATUS.IN_PROGRESS],
      });
    }
    await client.query("COMMIT");
    committed = true;

    broadcastQueueUpdate(doctorId, {
      queueId: queue.id,
      type: "PATIENT_MISSED",
      triggeredBy: req.user?.role,
      patientId: missedPatientId ?? undefined,
      medicalCenterId: queue.medical_center_id,
      sessionId: queue.schedule_id,
    });

    try {
      const doctorTokens = await loadDoctorTokens(doctorId);
      await sendExpoPush(
        doctorTokens.map((token) => ({
          to: token,
          title: "Patient Skipped",
          body: "The current patient was marked as skipped.",
          data: { queueId: queue.id },
        }))
      );
    } catch (error) {
      console.error("Patient skipped push error:", error);
    }

    return res.json({
      message: "Patient skipped successfully",
    });
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    console.error("Skip patient error:", error);
    return handleControllerError(res, error, "Server error");
  } finally {
    client.release();
  }
};

export const endQueue = async (req: DoctorQueueRequest<EndQueueBody>, res: Response) => {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    const userId = getDoctorUserId(req);
    const doctorId = await requireDoctorIdForUser(userId, client);
    const queue = await getLatestQueueForDoctorToday(doctorId, client);

    if (!queue) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "No active queue found today" });
    }

    const activePatientResult = await client.query<{ id: number }>(
      `
      SELECT id
      FROM queue_patients
      WHERE queue_id = $1
        AND status = 'WITH_DOCTOR'
      LIMIT 1
      FOR UPDATE
      `,
      [queue.id]
    );

    if (activePatientResult.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "Finish or skip the current patient before ending the clinic.",
      });
    }

    const waitingPatientsResult = await client.query<{ patient_id: number }>(
      `
      SELECT patient_id
      FROM queue_patients
      WHERE queue_id = $1
        AND status = 'WAITING'
      FOR UPDATE
      `,
      [queue.id]
    );

    const forceEnd = Boolean(req.body?.force);
    if (waitingPatientsResult.rows.length > 0 && !forceEnd) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "There are waiting patients. End clinic anyway?",
        requiresConfirmation: true,
      });
    }

    if (waitingPatientsResult.rows.length > 0) {
      const missedPatients = await client.query<{ patient_id: number }>(
        `
        UPDATE queue_patients
        SET status = 'MISSED',
            missed_at = NOW()
        WHERE queue_id = $1
          AND status = 'WAITING'
        RETURNING patient_id
        `,
        [queue.id]
      );

      for (const row of missedPatients.rows) {
        await updateNearestBookingStatus(client, {
          doctorId: Number(doctorId),
          patientId: Number(row.patient_id),
          nextStatus: BOOKING_STATUS.MISSED,
          allowedCurrentStatuses: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.BOOKED],
        });
      }
    }

    const endedQueueResult = await client.query<QueueRow>(
      `
      UPDATE queues
      SET status = 'ENDED'
      WHERE id = $1
      RETURNING *
      `,
      [queue.id]
    );

    await client.query("COMMIT");
    committed = true;

    const endedQueue = endedQueueResult.rows[0];

    broadcastQueueUpdate(doctorId, {
      queueId: queue.id,
      type: "CLINIC_ENDED",
      triggeredBy: req.user?.role,
      medicalCenterId: queue.medical_center_id,
      sessionId: queue.schedule_id,
    });

    try {
      await notifyQueuePatients(queue.id, async (patientId) => {
        broadcastQueueUpdate(doctorId, {
          queueId: queue.id,
          type: "CLINIC_ENDED",
          triggeredBy: req.user?.role,
          patientId,
          medicalCenterId: queue.medical_center_id,
          sessionId: queue.schedule_id,
        });
      });
    } catch (error) {
      console.error("Clinic ended room broadcast error:", error);
    }

    return res.json({
      message: "Clinic ended successfully",
      queue: endedQueue,
    });
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    console.error("End clinic error:", error);
    return handleControllerError(res, error, "Server error");
  } finally {
    client.release();
  }
};
