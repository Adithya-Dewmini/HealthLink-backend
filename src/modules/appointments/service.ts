import pool from "../../config/db";
import {
  BOOKING_NOW_SQL,
  BOOKING_SCHEDULED_AT_SQL,
  DEFAULT_BOOKING_GRACE_PERIOD_MINUTES,
  markMissedBookings,
  normalizeBookingStatus,
} from "../../utils/bookingLifecycle";

export const syncAndFetchPatientBookings = async (patientId: number) => {
  await markMissedBookings(pool, { patientId });

  const result = await pool.query(
    `
    SELECT b.id,
           b.doctor_id,
           b.medical_center_id,
           b.session_id,
           b.date,
           b.time,
           b.status,
           b.scheduled_at,
           b.started_at,
           b.ended_at,
           s.date::text AS session_date,
           s.start_time::text AS session_start_time,
           s.end_time::text AS session_end_time,
           live_queue.queue_id,
           live_queue.queue_status,
           live_queue.queue_started_at,
           live_queue.queue_ended_at,
           queue_patient.queue_patient_status,
           queue_patient.queue_token_number,
           queue_patient.queue_checked_in_at,
           queue_patient.queue_missed_at,
           queue_progress.current_serving_token,
           queue_progress.waiting_count,
           COALESCE(b.grace_period_minutes, $2) AS grace_period_minutes,
           (
             ${BOOKING_NOW_SQL} > ${BOOKING_SCHEDULED_AT_SQL}
             AND ${BOOKING_NOW_SQL} <= ${BOOKING_SCHEDULED_AT_SQL}
               + make_interval(mins => COALESCE(b.grace_period_minutes, $2))
           ) AS is_late,
           u.name AS doctor_name,
           mc.name AS medical_center_name
    FROM bookings b
    JOIN doctors d ON d.id = b.doctor_id
    JOIN users u ON u.id = d.user_id
    LEFT JOIN medical_center_doctor_schedule s ON s.id = b.session_id
    LEFT JOIN LATERAL (
      SELECT
        q.id AS queue_id,
        q.status AS queue_status,
        q.started_at::text AS queue_started_at,
        q.ended_at::text AS queue_ended_at
      FROM queues q
      WHERE q.schedule_id = b.session_id
        AND q.medical_center_id = b.medical_center_id
        AND q.shift_date = b.date
      ORDER BY
        CASE
          WHEN q.status IN ('LIVE', 'PAUSED') THEN 0
          WHEN q.status = 'ENDED' THEN 2
          ELSE 1
        END,
        q.created_at DESC
      LIMIT 1
    ) live_queue ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        qp.status AS queue_patient_status,
        qp.token_number AS queue_token_number,
        qp.checked_in_at::text AS queue_checked_in_at,
        qp.missed_at::text AS queue_missed_at
      FROM queue_patients qp
      WHERE qp.queue_id = live_queue.queue_id
        AND qp.patient_id = b.patient_id
      ORDER BY qp.id DESC
      LIMIT 1
    ) queue_patient ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        (
          SELECT qp_live.token_number
          FROM queue_patients qp_live
          WHERE qp_live.queue_id = live_queue.queue_id
            AND qp_live.status = 'WITH_DOCTOR'
          ORDER BY qp_live.id DESC
          LIMIT 1
        ) AS current_serving_token,
        (
          SELECT COUNT(*)::int
          FROM queue_patients qp_waiting
          WHERE qp_waiting.queue_id = live_queue.queue_id
            AND qp_waiting.status = 'WAITING'
        ) AS waiting_count
    ) queue_progress ON TRUE
    LEFT JOIN medical_centers mc ON mc.id = b.medical_center_id
    WHERE b.patient_id = $1
    ORDER BY b.date DESC, b.time DESC
    `,
    [patientId, DEFAULT_BOOKING_GRACE_PERIOD_MINUTES]
  );

  return result.rows.map((row: any) => ({
    ...row,
    status: normalizeBookingStatus(row.status),
  }));
};
