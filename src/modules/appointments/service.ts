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
