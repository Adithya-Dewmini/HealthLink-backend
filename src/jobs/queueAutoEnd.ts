import type { Server } from "socket.io";
import pool from "../config/db";
import { env } from "../config/env";
import { emitClinicPublicQueueUpdate } from "../services/clinicRealtime.service";
import { SOCKET_EVENTS, logRealtimeEmit } from "../services/realtime.service";
import { BOOKING_STATUS, markMissedBookings, updateNearestBookingStatus } from "../utils/bookingLifecycle";

const APP_TZ = env.appTz;
const APP_TIME_SQL = `(now() AT TIME ZONE '${APP_TZ}')::time`;
const APP_DATE_SQL = `(now() AT TIME ZONE '${APP_TZ}')::date`;

const doctorRoom = (doctorId: number | string) => `doctor_${doctorId}`;
const legacyDoctorRoom = (doctorId: number | string) => `doctor-${doctorId}`;
const patientRoom = (patientId: number | string) => `patient_${patientId}`;
const receptionRoom = "reception";

const emitQueueEnded = (
  io: Server,
  doctorId: number | string,
  queueId: number,
  patientIds: any[],
  medicalCenterId?: string | null
) => {
  const payload = { queueId, type: "CLINIC_ENDED", triggeredBy: "system", doctorId, medicalCenterId };
  for (const room of [doctorRoom(doctorId), legacyDoctorRoom(doctorId), receptionRoom]) {
    io.to(room).emit(SOCKET_EVENTS.queueUpdate, payload);
    logRealtimeEmit(SOCKET_EVENTS.queueUpdate, room, payload);
  }
  if (medicalCenterId) {
    const room = `center_${medicalCenterId}`;
    io.to(room).emit(SOCKET_EVENTS.queueUpdate, payload);
    logRealtimeEmit(SOCKET_EVENTS.queueUpdate, room, payload);
    emitClinicPublicQueueUpdate({
      clinicId: medicalCenterId,
      doctorId,
      queueId,
      type: payload.type,
    });
  }
  for (const row of patientIds) {
    if (!row?.patient_id) continue;
    const room = patientRoom(row.patient_id);
    io.to(room).emit(SOCKET_EVENTS.queueUpdate, payload);
    logRealtimeEmit(SOCKET_EVENTS.queueUpdate, room, payload);
  }
};

export const startQueueAutoEnd = (io: Server) => {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const queuesResult = await pool.query(
        `
        SELECT q.id, q.doctor_id, q.medical_center_id
        FROM queues q
        LEFT JOIN doctor_availability da ON da.id = q.shift_id
        WHERE q.status IN ('LIVE', 'PAUSED')
          AND (
            q.shift_date < ${APP_DATE_SQL}
            OR (q.shift_date = ${APP_DATE_SQL} AND da.end_time < ${APP_TIME_SQL})
          )
        `
      );

      for (const queue of queuesResult.rows) {
        const queueId = queue.id;
        const doctorId = queue.doctor_id;
        const medicalCenterId = queue.medical_center_id ?? null;

        const activeQueuePatients = await pool.query<{ patient_id: number | null }>(
          `
          SELECT patient_id
          FROM queue_patients
          WHERE queue_id = $1
            AND status = 'WITH_DOCTOR'
          `,
          [queueId]
        );

        if (activeQueuePatients.rows.length > 0) {
          console.warn("[queueAutoEnd] skipped queue end because an active patient is still in the queue", {
            queueId,
            doctorId,
            activePatientCount: activeQueuePatients.rows.length,
          });
          continue;
        }

        const missedPatients = await pool.query(
          `
          UPDATE queue_patients
          SET status = 'MISSED',
              missed_at = NOW()
          WHERE queue_id = $1
            AND status = 'WAITING'
          RETURNING patient_id
          `,
          [queueId]
        );

        for (const row of missedPatients.rows) {
          await updateNearestBookingStatus(pool, {
            doctorId: Number(doctorId),
            patientId: Number(row.patient_id),
            nextStatus: BOOKING_STATUS.MISSED,
            allowedCurrentStatuses: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.BOOKED],
          });
        }

        await pool.query(
          `
          UPDATE bookings
          SET status = '${BOOKING_STATUS.MISSED}',
              missed_at = COALESCE(missed_at, NOW())
          WHERE session_id = (
              SELECT schedule_id
              FROM queues
              WHERE id = $1
              LIMIT 1
            )
            AND date = ${APP_DATE_SQL}
            AND COALESCE(UPPER(status), '${BOOKING_STATUS.BOOKED}') IN ('${BOOKING_STATUS.BOOKED}', '${BOOKING_STATUS.CONFIRMED}')
          `,
          [queueId]
        );

        await pool.query(
          `
          UPDATE queues
          SET status = 'ENDED'
          WHERE id = $1
          `,
          [queueId]
        );

        const patientIds = await pool.query(
          `SELECT DISTINCT patient_id FROM queue_patients WHERE queue_id = $1`,
          [queueId]
        );

        emitQueueEnded(io, doctorId, queueId, patientIds.rows, medicalCenterId);
      }

      await markMissedBookings(pool);
    } catch (err) {
      console.error("Queue auto-end job error:", err);
    } finally {
      running = false;
    }
  };

  void run();
  setInterval(run, 60_000);
};
