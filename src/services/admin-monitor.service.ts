import pool from "../config/db";

type QueueItemRow = {
  session_id: string | null;
  clinic_name: string | null;
  doctor_name: string | null;
  waiting_count: number;
  current_token: number | null;
  queue_status: string;
  started_at: string | null;
};

type SessionItemRow = {
  session_id: string;
  doctor_name: string | null;
  clinic_name: string | null;
  status: string;
  start_time: string | null;
  end_time: string | null;
  booked_patients_count: number;
  queue_active: boolean;
};

type PeakHourRow = {
  hour: string;
  bookings_count: number;
};

type PrescriptionRow = {
  id: string;
  patient_name: string | null;
  doctor_name: string | null;
  clinic_name: string | null;
  linked_pharmacy: string | null;
  status: string | null;
  issued_at: string | null;
  dispensed_at: string | null;
};

const normalizeQueueStatus = (value: string | null) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "live") return "active";
  if (normalized === "paused") return "paused";
  if (normalized === "completed") return "completed";
  if (normalized === "cancelled") return "cancelled";
  if (normalized === "missed") return "missed";
  return "waiting";
};

const normalizeSessionStatus = (value: string | null) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "not_started") return "scheduled";
  if (normalized === "live") return "active";
  if (normalized === "paused") return "paused";
  if (normalized === "completed") return "completed";
  if (normalized === "cancelled") return "cancelled";
  return "scheduled";
};

const normalizePrescriptionStatus = (value: string | null) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "draft" ||
    normalized === "issued" ||
    normalized === "dispensed" ||
    normalized === "cancelled" ||
    normalized === "expired" ||
    normalized === "pending"
  ) {
    return normalized;
  }
  return "pending";
};

export const getAdminMonitorQueues = async () => {
  const result = await pool.query<QueueItemRow>(
    `
    SELECT
      COALESCE(q.schedule_id::text, q.shift_id::text, q.id::text) AS session_id,
      mc.name AS clinic_name,
      doctor_user.name AS doctor_name,
      COALESCE(queue_counts.waiting_count, 0) AS waiting_count,
      queue_counts.current_token,
      q.status AS queue_status,
      q.started_at::text AS started_at
    FROM queues q
    LEFT JOIN doctors d ON d.id = q.doctor_id
    LEFT JOIN users doctor_user ON doctor_user.id = d.user_id
    LEFT JOIN medical_centers mc ON mc.id = q.medical_center_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS waiting_count,
        MIN(qp.token_number) FILTER (
          WHERE LOWER(COALESCE(qp.status, '')) IN ('serving', 'in_progress', 'active')
        )::int AS current_token
      FROM queue_patients qp
      WHERE qp.queue_id = q.id
        AND LOWER(COALESCE(qp.status, '')) NOT IN ('completed', 'cancelled', 'missed')
    ) queue_counts ON TRUE
    WHERE UPPER(COALESCE(q.status, '')) IN ('LIVE', 'PAUSED')
    ORDER BY q.started_at DESC NULLS LAST, q.created_at DESC
    `
  );

  return {
    items: result.rows.map((row) => ({
      session_id: row.session_id,
      clinic_name: row.clinic_name || "Unknown medical center",
      doctor_name: row.doctor_name || "Unknown doctor",
      waiting_count: row.waiting_count,
      current_token: row.current_token,
      queue_status: normalizeQueueStatus(row.queue_status),
      started_at: row.started_at,
    })),
    generated_at: new Date().toISOString(),
  };
};

export const getAdminMonitorSessions = async () => {
  const result = await pool.query<SessionItemRow>(
    `
    SELECT
      s.id::text AS session_id,
      doctor_user.name AS doctor_name,
      mc.name AS clinic_name,
      s.status,
      s.start_time::text AS start_time,
      s.end_time::text AS end_time,
      COALESCE(booking_counts.booked_patients_count, 0) AS booked_patients_count,
      COALESCE(queue_status.queue_active, FALSE) AS queue_active
    FROM medical_center_doctor_schedule s
    LEFT JOIN users doctor_user ON doctor_user.id = s.doctor_user_id
    LEFT JOIN medical_centers mc ON mc.id = s.medical_center_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS booked_patients_count
      FROM bookings b
      WHERE b.session_id = s.id
        AND UPPER(COALESCE(b.status, '')) <> 'CANCELLED'
    ) booking_counts ON TRUE
    LEFT JOIN LATERAL (
      SELECT TRUE AS queue_active
      FROM queues q
      WHERE q.schedule_id = s.id
        AND UPPER(COALESCE(q.status, '')) IN ('LIVE', 'PAUSED')
      LIMIT 1
    ) queue_status ON TRUE
    WHERE s.date >= CURRENT_DATE - INTERVAL '1 day'
    ORDER BY s.date DESC, s.start_time DESC
    LIMIT 100
    `
  );

  return {
    items: result.rows.map((row) => ({
      session_id: row.session_id,
      doctor_name: row.doctor_name || "Unknown doctor",
      clinic_name: row.clinic_name || "Unknown medical center",
      status: normalizeSessionStatus(row.status),
      start_time: row.start_time,
      end_time: row.end_time,
      booked_patients_count: row.booked_patients_count,
      queue_active: row.queue_active,
    })),
    generated_at: new Date().toISOString(),
  };
};

export const getAdminMonitorBookings = async () => {
  const [summaryResult, peakHoursResult] = await Promise.all([
    pool.query<{
      today_total_bookings: number;
      pending: number;
      confirmed: number;
      completed: number;
      missed: number;
      cancelled: number;
      consultations_in_progress: number;
    }>(
      `
      SELECT
        COUNT(*)::int AS today_total_bookings,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(b.status, 'BOOKED')) IN ('BOOKED', 'PENDING'))::int AS pending,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(b.status, '')) = 'CONFIRMED')::int AS confirmed,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(b.status, '')) = 'COMPLETED')::int AS completed,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(b.status, '')) = 'MISSED')::int AS missed,
        COUNT(*) FILTER (WHERE UPPER(COALESCE(b.status, '')) = 'CANCELLED')::int AS cancelled,
        (
          SELECT COUNT(*)::int
          FROM consultations c
          WHERE c.created_at::date = CURRENT_DATE
            AND LOWER(COALESCE(c.status, '')) IN ('in_progress', 'active')
        ) AS consultations_in_progress
      FROM bookings b
      WHERE b.date = CURRENT_DATE
      `
    ),
    pool.query<PeakHourRow>(
      `
      SELECT
        TO_CHAR(b.time, 'HH24:00') AS hour,
        COUNT(*)::int AS bookings_count
      FROM bookings b
      WHERE b.date = CURRENT_DATE
      GROUP BY TO_CHAR(b.time, 'HH24:00')
      ORDER BY hour ASC
      `
    ),
  ]);

  const summary = summaryResult.rows[0] ?? {
    today_total_bookings: 0,
    pending: 0,
    confirmed: 0,
    completed: 0,
    missed: 0,
    cancelled: 0,
    consultations_in_progress: 0,
  };

  return {
    today_total_bookings: summary.today_total_bookings ?? 0,
    pending: summary.pending ?? 0,
    confirmed: summary.confirmed ?? 0,
    completed: summary.completed ?? 0,
    missed: summary.missed ?? 0,
    cancelled: summary.cancelled ?? 0,
    consultations_in_progress: summary.consultations_in_progress ?? 0,
    peak_hours_data: peakHoursResult.rows.map((row) => ({
      hour: row.hour,
      bookings_count: row.bookings_count,
    })),
  };
};

export const getAdminMonitorPrescriptions = async () => {
  const [summaryResult, recentResult] = await Promise.all([
    pool.query<{
      total_prescriptions_today: number;
      dispensed_count: number;
      pending_count: number;
    }>(
      `
      SELECT
        COUNT(*)::int AS total_prescriptions_today,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(p.status, 'pending')) = 'dispensed'
             OR p.dispensed_at::date = CURRENT_DATE
        )::int AS dispensed_count,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(p.status, 'pending')) IN ('pending', 'issued')
        )::int AS pending_count
      FROM prescriptions p
      WHERE p.issued_at::date = CURRENT_DATE
      `
    ),
    pool.query<PrescriptionRow>(
      `
      SELECT
        p.id::text AS id,
        patient_user.name AS patient_name,
        doctor_user.name AS doctor_name,
        mc.name AS clinic_name,
        NULL::text AS linked_pharmacy,
        LOWER(COALESCE(p.status, 'pending')) AS status,
        p.issued_at::text AS issued_at,
        p.dispensed_at::text AS dispensed_at
      FROM prescriptions p
      LEFT JOIN consultations c ON c.id = p.consultation_id
      LEFT JOIN users patient_user ON patient_user.id = c.patient_id
      LEFT JOIN users doctor_user ON doctor_user.id = c.doctor_id
      LEFT JOIN medical_centers mc ON mc.id = p.medical_center_id
      WHERE p.issued_at::date = CURRENT_DATE
      ORDER BY p.issued_at DESC
      LIMIT 20
      `
    ),
  ]);

  const summary = summaryResult.rows[0] ?? {
    total_prescriptions_today: 0,
    dispensed_count: 0,
    pending_count: 0,
  };

  return {
    total_prescriptions_today: summary.total_prescriptions_today ?? 0,
    dispensed_count: summary.dispensed_count ?? 0,
    pending_count: summary.pending_count ?? 0,
    recent_prescriptions: recentResult.rows.map((row) => ({
      id: row.id,
      patient_name: row.patient_name,
      doctor_name: row.doctor_name,
      clinic_name: row.clinic_name,
      linked_pharmacy: row.linked_pharmacy,
      status: normalizePrescriptionStatus(row.status),
      issued_at: row.issued_at,
      dispensed_at: row.dispensed_at,
    })),
  };
};
