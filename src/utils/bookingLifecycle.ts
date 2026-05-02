import { env } from "../config/env";

const APP_TZ = env.appTz;

export const BOOKING_STATUS = {
  BOOKED: "BOOKED",
  CONFIRMED: "CONFIRMED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  MISSED: "MISSED",
  CANCELLED: "CANCELLED",
} as const;

export const DEFAULT_BOOKING_GRACE_PERIOD_MINUTES = 15;

type DbClient = {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;
};

export const BOOKING_SCHEDULED_AT_SQL =
  "COALESCE(scheduled_at, ((date::timestamp) + time))";
export const BOOKING_NOW_SQL = `(NOW() AT TIME ZONE '${APP_TZ}')`;

export const normalizeBookingStatus = (value: unknown) => {
  const normalized = String(value ?? BOOKING_STATUS.BOOKED)
    .trim()
    .toUpperCase();

  switch (normalized) {
    case BOOKING_STATUS.BOOKED:
    case BOOKING_STATUS.CONFIRMED:
    case BOOKING_STATUS.IN_PROGRESS:
    case BOOKING_STATUS.COMPLETED:
    case BOOKING_STATUS.MISSED:
    case BOOKING_STATUS.CANCELLED:
      return normalized;
    default:
      return BOOKING_STATUS.BOOKED;
  }
};

export const markMissedBookings = async (
  client: DbClient,
  filters?: { patientId?: number; bookingId?: number; doctorId?: number }
) => {
  const conditions = [
    `COALESCE(UPPER(status), '${BOOKING_STATUS.BOOKED}') = ANY(ARRAY[
      '${BOOKING_STATUS.BOOKED}',
      '${BOOKING_STATUS.CONFIRMED}'
    ])`,
    `${BOOKING_SCHEDULED_AT_SQL} IS NOT NULL`,
    `${BOOKING_SCHEDULED_AT_SQL}
      + make_interval(mins => COALESCE(grace_period_minutes, ${DEFAULT_BOOKING_GRACE_PERIOD_MINUTES}))
      < ${BOOKING_NOW_SQL}`,
  ];
  const params: any[] = [];

  if (filters?.patientId) {
    params.push(filters.patientId);
    conditions.push(`patient_id = $${params.length}`);
  }
  if (filters?.bookingId) {
    params.push(filters.bookingId);
    conditions.push(`id = $${params.length}`);
  }
  if (filters?.doctorId) {
    params.push(filters.doctorId);
    conditions.push(`doctor_id = $${params.length}`);
  }

  const result = await client.query(
    `
    WITH target AS (
      SELECT id, COALESCE(UPPER(status), '${BOOKING_STATUS.BOOKED}') AS old_status
      FROM bookings
      WHERE ${conditions.join(" AND ")}
    )
    UPDATE bookings b
    SET status = '${BOOKING_STATUS.MISSED}',
        missed_at = COALESCE(b.missed_at, NOW())
    FROM target
    WHERE b.id = target.id
    RETURNING b.id, target.old_status, b.status AS new_status
    `,
    params
  );

  for (const row of result.rows) {
    console.log("STATUS CHANGE:", row.id, row.old_status, row.new_status);
  }

  return result;
};

export const updateNearestBookingStatus = async (
  client: DbClient,
  options: {
    doctorId: number;
    patientId: number;
    nextStatus: (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];
    allowedCurrentStatuses: string[];
    setStartedAt?: boolean;
    setEndedAt?: boolean;
  }
) => {
  const {
    doctorId,
    patientId,
    nextStatus,
    allowedCurrentStatuses,
    setStartedAt = false,
    setEndedAt = false,
  } = options;

  const normalizedStatuses = allowedCurrentStatuses.map(normalizeBookingStatus);

  const result = await client.query(
    `
    WITH target AS (
      SELECT id,
             COALESCE(UPPER(status), '${BOOKING_STATUS.BOOKED}') AS old_status,
             started_at,
             ended_at
      FROM bookings
      WHERE doctor_id = $4
        AND patient_id = $5
        AND COALESCE(UPPER(status), '${BOOKING_STATUS.BOOKED}') = ANY($6::text[])
        AND (
          $1 <> '${BOOKING_STATUS.COMPLETED}'
          OR (
            COALESCE(UPPER(status), '${BOOKING_STATUS.BOOKED}') = '${BOOKING_STATUS.IN_PROGRESS}'
            AND started_at IS NOT NULL
          )
        )
        AND (
          $1 <> '${BOOKING_STATUS.MISSED}'
          OR ended_at IS NULL
        )
      ORDER BY
        ABS(EXTRACT(EPOCH FROM (${BOOKING_SCHEDULED_AT_SQL} - ${BOOKING_NOW_SQL}))) ASC,
        id DESC
      LIMIT 1
    )
    UPDATE bookings b
    SET status = $1,
        started_at = CASE WHEN $2 THEN COALESCE(b.started_at, NOW()) ELSE b.started_at END,
        ended_at = CASE
          WHEN $1 = '${BOOKING_STATUS.MISSED}' THEN NULL
          WHEN $3 THEN COALESCE(b.ended_at, NOW())
          ELSE b.ended_at
        END
    FROM target
    WHERE b.id = target.id
    RETURNING b.id,
              target.old_status,
              b.status AS new_status,
              b.started_at,
              b.ended_at
    `,
    [nextStatus, setStartedAt, setEndedAt, doctorId, patientId, normalizedStatuses]
  );

  for (const row of result.rows) {
    console.log("STATUS CHANGE:", row.id, row.old_status, row.new_status);
  }

  return result;
};
