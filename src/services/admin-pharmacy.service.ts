import pool from "../config/db";

type ListPharmaciesOptions = {
  search?: string;
  verificationStatus?: string;
  activityLevel?: "high" | "medium" | "low";
  page?: number;
  pageSize?: number;
};

type PharmacyListRow = {
  id: string;
  name: string;
  location: string | null;
  verification_status: string;
  is_active: boolean;
  last_active_at: string | null;
  inventory_size: number;
  dispensing_count: number;
  demand_log_count: number;
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

const buildWhereClause = (options: ListPharmaciesOptions) => {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (typeof options.search === "string" && options.search.trim().length > 0) {
    params.push(`%${options.search.trim().toLowerCase()}%`);
    clauses.push(`
      (
        LOWER(p.name) LIKE $${params.length}
        OR LOWER(COALESCE(p.location, '')) LIKE $${params.length}
      )
    `);
  }

  if (typeof options.verificationStatus === "string" && options.verificationStatus.trim().length > 0) {
    params.push(options.verificationStatus.trim().toLowerCase());
    clauses.push(`LOWER(COALESCE(p.verification_status, 'pending')) = $${params.length}`);
  }

  if (options.activityLevel === "high") {
    clauses.push(`COALESCE(activity_counts.dispensing_count, 0) >= 20`);
  } else if (options.activityLevel === "medium") {
    clauses.push(`COALESCE(activity_counts.dispensing_count, 0) BETWEEN 5 AND 19`);
  } else if (options.activityLevel === "low") {
    clauses.push(`COALESCE(activity_counts.dispensing_count, 0) < 5`);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
};

const basePharmaciesSql = `
  FROM pharmacies p
  LEFT JOIN LATERAL (
    SELECT
      NULL::text AS last_active_at,
      0::int AS dispensing_count
  ) activity_counts ON TRUE
`;

export const listAdminPharmacies = async (options: ListPharmaciesOptions = {}) => {
  const page = normalizePositiveInteger(options.page, DEFAULT_PAGE);
  const pageSize = normalizePositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const { whereSql, params } = buildWhereClause(options);

  const [listResult, countResult] = await Promise.all([
    pool.query<PharmacyListRow>(
      `
      SELECT
        p.id::text AS id,
        p.name,
        COALESCE(p.location, 'Not provided') AS location,
        LOWER(COALESCE(p.verification_status, 'pending')) AS verification_status,
        CASE
          WHEN LOWER(COALESCE(p.status, 'active')) IN ('inactive', 'disabled', 'closed') THEN FALSE
          ELSE TRUE
        END AS is_active,
        activity_counts.last_active_at,
        0::int AS inventory_size,
        COALESCE(activity_counts.dispensing_count, 0) AS dispensing_count,
        0::int AS demand_log_count
      ${basePharmaciesSql}
      ${whereSql}
      ORDER BY p.created_at DESC, p.name ASC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    ),
    pool.query<{ count: number }>(
      `
      SELECT COUNT(*)::int AS count
      ${basePharmaciesSql}
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
      verification_status: row.verification_status,
      is_active: row.is_active,
      last_active_at: row.last_active_at,
      inventory_size: row.inventory_size,
      dispensing_count: row.dispensing_count,
      demand_log_count: row.demand_log_count,
    })),
    pagination: {
      total,
      page,
      pageSize,
      totalPages,
    },
  };
};
