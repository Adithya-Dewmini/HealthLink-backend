import pool from "../config/db";

type ListMedicalCentersOptions = {
  search?: string;
  isActive?: "true" | "false";
  verificationStatus?: string;
  page?: number;
  pageSize?: number;
};

type MedicalCenterListRow = {
  id: string;
  name: string;
  location: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  verification_status: string;
  active_doctors_count: number;
  receptionists_count: number;
  live_queues_count: number;
  today_bookings_count: number;
  created_at: string;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const normalizePositiveInteger = (value: number | undefined, fallback: number, max?: number) => {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }

  return typeof max === "number" ? Math.min(value, max) : value;
};

const buildWhereClause = (options: ListMedicalCentersOptions) => {
  const clauses: string[] = [];
  const params: Array<string | boolean> = [];

  if (typeof options.search === "string" && options.search.trim().length > 0) {
    params.push(`%${options.search.trim().toLowerCase()}%`);
    clauses.push(`
      (
        LOWER(mc.name) LIKE $${params.length}
        OR LOWER(COALESCE(mc.city, '')) LIKE $${params.length}
        OR LOWER(COALESCE(mc.address, '')) LIKE $${params.length}
        OR LOWER(COALESCE(mc.email, '')) LIKE $${params.length}
        OR LOWER(COALESCE(mc.phone, '')) LIKE $${params.length}
      )
    `);
  }

  if (options.isActive === "true" || options.isActive === "false") {
    params.push(options.isActive === "true");
    clauses.push(`COALESCE(mc.is_active, TRUE) = $${params.length}`);
  }

  if (typeof options.verificationStatus === "string" && options.verificationStatus.trim().length > 0) {
    params.push(options.verificationStatus.trim().toLowerCase());
    clauses.push(`LOWER(COALESCE(mc.verification_status, 'pending')) = $${params.length}`);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
};

const baseMedicalCentersSql = `
  FROM medical_centers mc
  LEFT JOIN LATERAL (
    SELECT COUNT(DISTINCT active_doctor_links.doctor_user_id)::int AS active_doctors_count
    FROM (
      SELECT d.user_id AS doctor_user_id
      FROM doctors d
      WHERE d.medical_center_id = mc.id
        AND d.user_id IS NOT NULL
      UNION
      SELECT mcd.doctor_id AS doctor_user_id
      FROM medical_center_doctors mcd
      WHERE mcd.medical_center_id = mc.id
        AND UPPER(mcd.status::text) = 'ACTIVE'
    ) active_doctor_links
  ) doctor_counts ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS receptionists_count
    FROM receptionists r
    WHERE r.medical_center_id = mc.id
  ) receptionist_counts ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS live_queues_count
    FROM queues q
    WHERE q.medical_center_id = mc.id
      AND UPPER(COALESCE(q.status, '')) IN ('LIVE', 'PAUSED')
  ) queue_counts ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS today_bookings_count
    FROM bookings b
    WHERE b.medical_center_id = mc.id
      AND b.date = CURRENT_DATE
  ) booking_counts ON TRUE
`;

export const listAdminMedicalCenters = async (options: ListMedicalCentersOptions = {}) => {
  const page = normalizePositiveInteger(options.page, DEFAULT_PAGE);
  const pageSize = normalizePositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const { whereSql, params } = buildWhereClause(options);

  const [listResult, countResult] = await Promise.all([
    pool.query<MedicalCenterListRow>(
      `
      SELECT
        mc.id::text AS id,
        mc.name,
        COALESCE(mc.city, mc.address, 'Not provided') AS location,
        mc.email,
        mc.phone,
        COALESCE(mc.is_active, TRUE) AS is_active,
        LOWER(COALESCE(mc.verification_status, 'pending')) AS verification_status,
        COALESCE(doctor_counts.active_doctors_count, 0) AS active_doctors_count,
        COALESCE(receptionist_counts.receptionists_count, 0) AS receptionists_count,
        COALESCE(queue_counts.live_queues_count, 0) AS live_queues_count,
        COALESCE(booking_counts.today_bookings_count, 0) AS today_bookings_count,
        mc.created_at::text AS created_at
      ${baseMedicalCentersSql}
      ${whereSql}
      ORDER BY mc.created_at DESC, mc.name ASC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    ),
    pool.query<{ count: number }>(
      `
      SELECT COUNT(*)::int AS count
      ${baseMedicalCentersSql}
      ${whereSql}
      `,
      params
    ),
  ]);

  const total = countResult.rows[0]?.count ?? 0;
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;

  return {
    items: listResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      location: row.location || "Not provided",
      email: row.email,
      phone: row.phone,
      is_active: row.is_active,
      verification_status: row.verification_status,
      active_doctors_count: row.active_doctors_count,
      receptionists_count: row.receptionists_count,
      live_queues_count: row.live_queues_count,
      today_bookings_count: row.today_bookings_count,
      created_at: row.created_at,
    })),
    pagination: {
      total,
      page,
      pageSize,
      totalPages,
    },
  };
};
