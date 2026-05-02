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

type QueueStartBody = {
  scheduleId?: number | string | null;
};

type AddPatientBody = {
  patient_id?: number | string | null;
  complaint?: string;
  name?: string;
};

type DoctorQueueRequest<TBody = Record<string, unknown>> = AuthenticatedRequest<TBody>;
type HttpError = Error & { statusCode?: number };

type QueueRow = {
  id: number;
  doctor_id: number;
  status: string;
  shift_id: number | null;
  schedule_id: number | null;
  shift_date: string;
  medical_center_id: string | null;
};

type QueuePatientRow = {
  id: number;
  patient_id: number;
  token_number: number;
  consultation_id: number | null;
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
  payload: { queueId: number; type: string; triggeredBy?: string; patientId?: number | string }
) => {
  const enrichedPayload = { ...payload, doctorId };
  io.to(doctorRoom(doctorId)).emit("queue:update", enrichedPayload);
  io.to(legacyDoctorRoom(doctorId)).emit("queue:update", enrichedPayload);
  io.to(doctorRoom(doctorId)).emit("queueUpdated", enrichedPayload);
  io.to(legacyDoctorRoom(doctorId)).emit("queueUpdated", enrichedPayload);
  io.to(receptionRoom).emit("queue:update", enrichedPayload);
  io.to(receptionRoom).emit("queueUpdated", enrichedPayload);

  if (payload.patientId) {
    io.to(patientRoom(payload.patientId)).emit("queue:update", enrichedPayload);
    io.to(patientRoom(payload.patientId)).emit("queueUpdated", enrichedPayload);
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

export const startQueue = async (
  req: DoctorQueueRequest<QueueStartBody>,
  res: Response
) => {
  try {
    const userId = getDoctorUserId(req);
    const requestedScheduleId = req.body?.scheduleId ?? null;
    const doctorId = await requireDoctorIdForUser(userId);
    const activeSchedule = await resolveStartableSchedule(doctorId, requestedScheduleId);

    if (!activeSchedule?.id) {
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
      });

      try {
        await notifyQueuePatients(queueIdToEnd, async (patientId) => {
          broadcastQueueUpdate(doctorId, {
            queueId: queueIdToEnd,
            type: "CLINIC_ENDED",
            triggeredBy: req.user?.role,
            patientId,
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
    const shiftStart = activeSchedule.start_time ?? null;
    const shiftEnd = activeSchedule.end_time ?? null;

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
      WHERE b.doctor_id = $2
        AND b.date = ${APP_DATE_SQL}
        AND ($3::time IS NULL OR b.time >= $3)
        AND ($4::time IS NULL OR b.time <= $4)
        AND NOT EXISTS (
          SELECT 1
          FROM queue_patients qp
          WHERE qp.queue_id = $1
            AND qp.patient_id = b.patient_id
        )
      `,
      [newQueue.id, doctorId, shiftStart, shiftEnd, newQueue.medical_center_id ?? null]
    );

    broadcastQueueUpdate(doctorId, {
      queueId: newQueue.id,
      type: "QUEUE_STARTED",
      triggeredBy: req.user?.role,
    });

    try {
      await notifyQueuePatients(newQueue.id, async (patientId) => {
        broadcastQueueUpdate(doctorId, {
          queueId: newQueue.id,
          type: "QUEUE_STARTED",
          triggeredBy: req.user?.role,
          patientId,
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

    const completedPatients = await client.query<{ patient_id: number }>(
      `
      UPDATE queue_patients
      SET status = 'COMPLETED',
          completed_at = NOW()
      WHERE queue_id = $1
        AND status = 'WITH_DOCTOR'
      RETURNING patient_id
      `,
      [queue.id]
    );

    for (const row of completedPatients.rows) {
      await updateNearestBookingStatus(client, {
        doctorId: Number(doctorId),
        patientId: Number(row.patient_id),
        nextStatus: BOOKING_STATUS.COMPLETED,
        allowedCurrentStatuses: [BOOKING_STATUS.IN_PROGRESS],
        setEndedAt: true,
      });
    }

    const nextPatientResult = await client.query<QueuePatientRow>(
      `
      SELECT *
      FROM queue_patients
      WHERE queue_id = $1
        AND status = 'WAITING'
      ORDER BY token_number ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
      `,
      [queue.id]
    );

    const nextPatient = nextPatientResult.rows[0];
    if (!nextPatient) {
      await client.query("COMMIT");

      broadcastQueueUpdate(doctorId, {
        queueId: queue.id,
        type: "QUEUE_EMPTY",
        triggeredBy: req.user?.role,
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

      return res.status(409).json({ message: "Queue Empty" });
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
      doctorId: Number(doctorId),
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
          userId,
          queue.id,
          null,
          null,
          null,
          JSON.stringify([]),
          queue.medical_center_id ?? null,
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

    await client.query("COMMIT");

    try {
      const currentToken = updatedPatientResult.rows[0]?.token_number ?? nextPatient.token_number;
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
    });

    try {
      await notifyQueuePatients(queue.id, async (patientId) => {
        broadcastQueueUpdate(doctorId, {
          queueId: queue.id,
          type: "NEXT_PATIENT",
          triggeredBy: req.user?.role,
          patientId,
        });
      });
    } catch (error) {
      console.error("Next patient room broadcast error:", error);
    }

    return res.json({
      message: "Moved to next patient",
      patient: updatedPatientResult.rows[0],
      consultationId,
      queueId: queue.id,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Next patient error:", error);
    return handleControllerError(res, error, "Server error");
  } finally {
    client.release();
  }
};

export const skipPatient = async (req: DoctorQueueRequest, res: Response) => {
  try {
    const userId = getDoctorUserId(req);
    const doctorId = await requireDoctorIdForUser(userId);
    const queue = await getLiveQueueForDoctorToday(doctorId);

    if (!queue) {
      return res.status(404).json({ message: "No active queue found today" });
    }

    const skippedResult = await pool.query<{ id: number; patient_id: number | null }>(
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
      return res.status(400).json({ message: "No active patient to skip" });
    }

    const missedPatientId = skippedResult.rows[0]?.patient_id ?? null;
    if (missedPatientId) {
      await updateNearestBookingStatus(pool, {
        doctorId: Number(doctorId),
        patientId: Number(missedPatientId),
        nextStatus: BOOKING_STATUS.MISSED,
        allowedCurrentStatuses: [BOOKING_STATUS.IN_PROGRESS],
      });
    }

    const nextPatientResult = await pool.query<QueuePatientRow>(
      `
      SELECT *
      FROM queue_patients
      WHERE queue_id = $1
        AND status = 'WAITING'
      ORDER BY token_number ASC
      LIMIT 1
      `,
      [queue.id]
    );

    const nextPatient = nextPatientResult.rows[0];
    if (!nextPatient) {
      broadcastQueueUpdate(doctorId, {
        queueId: queue.id,
        type: "QUEUE_EMPTY",
        triggeredBy: req.user?.role,
      });

      try {
        const doctorTokens = await loadDoctorTokens(doctorId);
        await sendExpoPush(
          doctorTokens.map((token) => ({
            to: token,
            title: "Queue Empty",
            body: "No more patients waiting.",
            data: { queueId: queue.id },
          }))
        );
      } catch (error) {
        console.error("Queue empty push error:", error);
      }

      return res.json({ message: "No more patients in queue" });
    }

    const updatedPatient = await pool.query(
      `
      UPDATE queue_patients
      SET status = 'WITH_DOCTOR',
          started_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [nextPatient.id]
    );

    await updateNearestBookingStatus(pool, {
      doctorId: Number(doctorId),
      patientId: Number(nextPatient.patient_id),
      nextStatus: BOOKING_STATUS.IN_PROGRESS,
      allowedCurrentStatuses: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.BOOKED],
      setStartedAt: true,
    });

    broadcastQueueUpdate(doctorId, {
      queueId: queue.id,
      type: "PATIENT_MISSED",
      triggeredBy: req.user?.role,
      patientId: missedPatientId ?? undefined,
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
      message: "Patient skipped. Moved to next patient.",
      patient: updatedPatient.rows[0],
    });
  } catch (error) {
    console.error("Skip patient error:", error);
    return handleControllerError(res, error, "Server error");
  }
};

export const endQueue = async (req: DoctorQueueRequest, res: Response) => {
  try {
    const userId = getDoctorUserId(req);
    const doctorId = await requireDoctorIdForUser(userId);
    const queue = await getLatestQueueForDoctorToday(doctorId);

    if (!queue) {
      return res.status(404).json({ message: "No active queue found today" });
    }

    const completedPatients = await pool.query<{ patient_id: number }>(
      `
      UPDATE queue_patients
      SET status = 'COMPLETED',
          completed_at = NOW()
      WHERE queue_id = $1
        AND status = 'WITH_DOCTOR'
      RETURNING patient_id
      `,
      [queue.id]
    );

    for (const row of completedPatients.rows) {
      await updateNearestBookingStatus(pool, {
        doctorId: Number(doctorId),
        patientId: Number(row.patient_id),
        nextStatus: BOOKING_STATUS.COMPLETED,
        allowedCurrentStatuses: [BOOKING_STATUS.IN_PROGRESS],
        setEndedAt: true,
      });
    }

    const missedPatients = await pool.query<{ patient_id: number }>(
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
      await updateNearestBookingStatus(pool, {
        doctorId: Number(doctorId),
        patientId: Number(row.patient_id),
        nextStatus: BOOKING_STATUS.MISSED,
        allowedCurrentStatuses: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.BOOKED],
      });
    }

    const endedQueueResult = await pool.query<QueueRow>(
      `
      UPDATE queues
      SET status = 'ENDED'
      WHERE id = $1
      RETURNING *
      `,
      [queue.id]
    );

    const endedQueue = endedQueueResult.rows[0];

    broadcastQueueUpdate(doctorId, {
      queueId: queue.id,
      type: "CLINIC_ENDED",
      triggeredBy: req.user?.role,
    });

    try {
      await notifyQueuePatients(queue.id, async (patientId) => {
        broadcastQueueUpdate(doctorId, {
          queueId: queue.id,
          type: "CLINIC_ENDED",
          triggeredBy: req.user?.role,
          patientId,
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
    console.error("End clinic error:", error);
    return handleControllerError(res, error, "Server error");
  }
};
