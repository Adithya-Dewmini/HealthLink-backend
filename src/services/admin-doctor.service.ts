import pool from "../config/db";
import { columnExists } from "./admin.schema.service";

type ListDoctorsOptions = {
  search?: string;
  specialization?: string;
  verificationStatus?: string;
  isActive?: "true" | "false";
  page?: number;
  pageSize?: number;
};

type DoctorListRow = {
  id: string;
  name: string;
  email: string;
  specialization: string | null;
  verification_status: string;
  is_active: boolean;
  is_visible: boolean;
  created_at: string;
  active_clinic_count: number;
  pending_requests_count: number;
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

const buildWhereClause = (options: ListDoctorsOptions) => {
  const clauses: string[] = [];
  const params: Array<string | boolean> = [];

  if (typeof options.search === "string" && options.search.trim().length > 0) {
    params.push(`%${options.search.trim().toLowerCase()}%`);
    clauses.push(`
      (
        LOWER(u.name) LIKE $${params.length}
        OR LOWER(u.email) LIKE $${params.length}
        OR LOWER(COALESCE(d.specialization, '')) LIKE $${params.length}
      )
    `);
  }

  if (typeof options.specialization === "string" && options.specialization.trim().length > 0) {
    params.push(options.specialization.trim().toLowerCase());
    clauses.push(`LOWER(COALESCE(d.specialization, '')) = $${params.length}`);
  }

  if (typeof options.verificationStatus === "string" && options.verificationStatus.trim().length > 0) {
    params.push(options.verificationStatus.trim().toLowerCase());
    clauses.push(`LOWER(COALESCE(d.verification_status, 'pending')) = $${params.length}`);
  }

  if (options.isActive === "true" || options.isActive === "false") {
    params.push(options.isActive === "true");
    clauses.push(`COALESCE(u.is_active, TRUE) = $${params.length}`);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
};

const buildBaseDoctorsSql = (userIsActiveSql: string, userCreatedAtSql: string) => `
  FROM doctors d
  JOIN users u ON u.id = d.user_id
  LEFT JOIN LATERAL (
    SELECT COUNT(DISTINCT active_centers.medical_center_id)::int AS active_clinic_count
    FROM (
      SELECT d.medical_center_id AS medical_center_id
      WHERE d.medical_center_id IS NOT NULL
      UNION
      SELECT mcd.medical_center_id
      FROM medical_center_doctors mcd
      WHERE mcd.doctor_id = u.id
        AND UPPER(mcd.status::text) = 'ACTIVE'
    ) active_centers
  ) clinic_counts ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS pending_requests_count
    FROM doctor_join_requests djr
    WHERE djr.doctor_id = u.id
      AND UPPER(djr.status::text) = 'PENDING'
  ) join_request_counts ON TRUE
`;

export const listAdminDoctors = async (options: ListDoctorsOptions = {}) => {
  const hasUserIsActive = await columnExists("users", "is_active");
  const hasUserCreatedAt = await columnExists("users", "created_at");
  const userIsActiveSql = hasUserIsActive ? "COALESCE(u.is_active, TRUE)" : "TRUE";
  const userCreatedAtSql = hasUserCreatedAt ? "u.created_at::text" : "COALESCE(d.created_at::text, CURRENT_TIMESTAMP::text)";
  const doctorsOrderBySql = hasUserCreatedAt ? "u.created_at DESC, u.name ASC" : "d.created_at DESC, u.name ASC";
  const baseDoctorsSql = buildBaseDoctorsSql(userIsActiveSql, userCreatedAtSql);
  const page = normalizePositiveInteger(options.page, DEFAULT_PAGE);
  const pageSize = normalizePositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const { whereSql, params } = buildWhereClause(options);

  const [listResult, countResult] = await Promise.all([
    pool.query<DoctorListRow>(
      `
      SELECT
        d.id::text AS id,
        u.name,
        u.email,
        d.specialization,
        LOWER(COALESCE(d.verification_status, 'pending')) AS verification_status,
        ${userIsActiveSql} AS is_active,
        TRUE AS is_visible,
        ${userCreatedAtSql} AS created_at,
        COALESCE(clinic_counts.active_clinic_count, 0) AS active_clinic_count,
        COALESCE(join_request_counts.pending_requests_count, 0) AS pending_requests_count
      ${baseDoctorsSql}
      ${whereSql}
      ORDER BY ${doctorsOrderBySql}
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    ),
    pool.query<{ count: number }>(
      `
      SELECT COUNT(*)::int AS count
      ${baseDoctorsSql}
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
      email: row.email,
      specialization: row.specialization,
      verification_status: row.verification_status,
      is_active: row.is_active,
      is_visible: row.is_visible,
      created_at: row.created_at,
      active_clinic_count: row.active_clinic_count,
      pending_requests_count: row.pending_requests_count,
    })),
    pagination: {
      total,
      page,
      pageSize,
      totalPages,
    },
  };
};
