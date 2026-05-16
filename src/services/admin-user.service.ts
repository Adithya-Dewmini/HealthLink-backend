import pool from "../config/db";
import { columnExists } from "./admin.schema.service";
import { env } from "../config/env";
import { createAuditLogWithClient } from "./audit.service";
import { generateToken, hashToken, sha256 } from "../utils/security";

type ListAdminUsersOptions = {
  role?: string;
  isActive?: "true" | "false";
  affiliation?: "center" | "pharmacy";
  verificationState?: string;
  search?: string;
  page?: number;
  pageSize?: number;
};

type CreateAdminUserInput = {
  name: unknown;
  email: unknown;
  actorUserId: number;
};

type AdminUserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  is_active: boolean;
  created_at: string;
  verification_linked_state: string;
  center_name: string | null;
  pharmacy_name: string | null;
  affiliation_display: string;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const normalizeName = (value: unknown) => String(value || "").trim();
const validateEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  return error;
};

const getAdminSetupBaseUrl = () => {
  const baseUrl =
    env.appWebUrl?.trim() ||
    env.publicAppUrl?.trim() ||
    env.receptionistSetupUrl?.trim() ||
    null;

  return baseUrl ? baseUrl.replace(/\/$/, "") : null;
};

const buildAdminSetupLink = (token: string) => {
  const baseUrl = getAdminSetupBaseUrl();
  const scheme = String(env.mobileAppScheme || "healthlink").trim();
  return baseUrl
    ? `${baseUrl}/setup-password?token=${encodeURIComponent(token)}`
    : `${scheme}://set-password?token=${encodeURIComponent(token)}`;
};

const createPasswordSetupToken = async (userId: number) => {
  const rawToken = generateToken();
  const lookupHash = sha256(rawToken);
  const hashedToken = await hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await pool.query(
    `
      INSERT INTO password_setup_tokens (user_id, token, token_lookup_hash, expires_at, is_used)
      VALUES ($1, $2, $3, $4, FALSE)
    `,
    [userId, hashedToken, lookupHash, expiresAt]
  );

  return {
    rawToken,
    expiresAt: expiresAt.toISOString(),
  };
};

const normalizePositiveInteger = (value: number | undefined, fallback: number, max?: number) => {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }

  return typeof max === "number" ? Math.min(value, max) : value;
};

const buildWhereClause = (options: ListAdminUsersOptions) => {
  const clauses: string[] = [];
  const params: Array<string | number | boolean> = [];

  if (typeof options.role === "string" && options.role.trim().length > 0) {
    params.push(options.role.trim().toLowerCase());
    clauses.push(`LOWER(user_rows.role) = $${params.length}`);
  }

  if (options.isActive === "true" || options.isActive === "false") {
    params.push(options.isActive === "true");
    clauses.push(`user_rows.is_active = $${params.length}`);
  }

  if (options.affiliation === "center") {
    clauses.push(`user_rows.center_name IS NOT NULL`);
  } else if (options.affiliation === "pharmacy") {
    clauses.push(`user_rows.pharmacy_name IS NOT NULL`);
  }

  if (typeof options.verificationState === "string" && options.verificationState.trim().length > 0) {
    params.push(options.verificationState.trim().toLowerCase());
    clauses.push(`LOWER(user_rows.verification_linked_state) = $${params.length}`);
  }

  if (typeof options.search === "string" && options.search.trim().length > 0) {
    params.push(`%${options.search.trim().toLowerCase()}%`);
    clauses.push(`
      (
        LOWER(user_rows.name) LIKE $${params.length}
        OR LOWER(user_rows.email) LIKE $${params.length}
        OR LOWER(COALESCE(user_rows.center_name, '')) LIKE $${params.length}
        OR LOWER(COALESCE(user_rows.pharmacy_name, '')) LIKE $${params.length}
      )
    `);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
};

const buildBaseUsersSql = (userIsActiveSql: string, userCreatedAtSql: string) => `
  FROM (
    SELECT
      u.id::text AS id,
      u.name,
      u.email,
      LOWER(u.role) AS role,
      ${userIsActiveSql} AS is_active,
      ${userCreatedAtSql} AS created_at,
      CASE
        WHEN d.id IS NOT NULL THEN LOWER(COALESCE(d.verification_status, 'pending'))
        WHEN admin_center.id IS NOT NULL THEN LOWER(COALESCE(admin_center.verification_status, 'pending'))
        WHEN linked_pharmacy.id IS NOT NULL THEN LOWER(COALESCE(linked_pharmacy.verification_status, 'pending'))
        ELSE 'not_applicable'
      END AS verification_linked_state,
      COALESCE(admin_center.name, doctor_center.name, receptionist_center.name) AS center_name,
      linked_pharmacy.name AS pharmacy_name,
      COALESCE(
        admin_center.name,
        doctor_center.name,
        receptionist_center.name,
        linked_pharmacy.name,
        'Independent account'
      ) AS affiliation_display
    FROM users u
    LEFT JOIN LATERAL (
      SELECT mc.id, mc.name, mc.verification_status
      FROM medical_center_admins mca
      JOIN medical_centers mc ON mc.id = mca.medical_center_id
      WHERE mca.user_id = u.id
      ORDER BY mca.created_at ASC
      LIMIT 1
    ) admin_center ON TRUE
    LEFT JOIN doctors d ON d.user_id = u.id
    LEFT JOIN medical_centers doctor_center ON doctor_center.id = d.medical_center_id
    LEFT JOIN receptionists r ON r.user_id = u.id
    LEFT JOIN medical_centers receptionist_center ON receptionist_center.id = r.medical_center_id
    LEFT JOIN LATERAL (
      SELECT p.id, p.name, p.verification_status
      FROM pharmacist_pharmacies pp
      JOIN pharmacies p ON p.id = pp.pharmacy_id
      WHERE pp.user_id = u.id
      ORDER BY pp.created_at ASC
      LIMIT 1
    ) linked_pharmacy ON TRUE
  ) user_rows
`;

export const listAdminUsers = async (options: ListAdminUsersOptions = {}) => {
  const hasUserIsActive = await columnExists("users", "is_active");
  const hasUserCreatedAt = await columnExists("users", "created_at");
  const userIsActiveSql = hasUserIsActive ? "COALESCE(u.is_active, TRUE)" : "TRUE";
  const userCreatedAtSql = hasUserCreatedAt ? "u.created_at::text" : "CURRENT_TIMESTAMP::text";
  const usersOrderBySql = hasUserCreatedAt ? "user_rows.created_at DESC, user_rows.name ASC" : "user_rows.name ASC, user_rows.id DESC";
  const baseUsersSql = buildBaseUsersSql(userIsActiveSql, userCreatedAtSql);
  const page = normalizePositiveInteger(options.page, DEFAULT_PAGE);
  const pageSize = normalizePositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const { whereSql, params } = buildWhereClause(options);

  const [listResult, countResult] = await Promise.all([
    pool.query<AdminUserRow>(
      `
      SELECT
        user_rows.id,
        user_rows.name,
        user_rows.email,
        user_rows.role,
        user_rows.is_active,
        user_rows.created_at,
        user_rows.verification_linked_state,
        user_rows.center_name,
        user_rows.pharmacy_name,
        user_rows.affiliation_display
      ${baseUsersSql}
      ${whereSql}
      ORDER BY ${usersOrderBySql}
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    ),
    pool.query<{ count: number }>(
      `
      SELECT COUNT(*)::int AS count
      ${baseUsersSql}
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
      role: row.role,
      is_active: row.is_active,
      created_at: row.created_at,
      verification_linked_state: row.verification_linked_state,
      affiliation: {
        center_name: row.center_name,
        pharmacy_name: row.pharmacy_name,
        display: row.affiliation_display,
      },
    })),
    pagination: {
      total,
      page,
      pageSize,
      totalPages,
    },
  };
};

export const createAdminUser = async (input: CreateAdminUserInput) => {
  const name = normalizeName(input.name);
  const email = normalizeEmail(input.email);

  if (!name || !email) {
    throw createStatusError("Name and email are required", 400);
  }

  if (!validateEmail(email)) {
    throw createStatusError("A valid email is required", 400);
  }

  const hasUserIsActive = await columnExists("users", "is_active");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingUser = await client.query<{ id: number }>(
      `SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );

    if (existingUser.rows.length > 0) {
      throw createStatusError("User already exists with this email", 409);
    }

    const userInsertSql = hasUserIsActive
      ? `
          INSERT INTO users (name, email, password, password_hash, is_password_set, role, is_active)
          VALUES ($1, $2, NULL, NULL, FALSE, 'admin', TRUE)
          RETURNING id, name, email, role, is_active
        `
      : `
          INSERT INTO users (name, email, password, password_hash, is_password_set, role)
          VALUES ($1, $2, NULL, NULL, FALSE, 'admin')
          RETURNING id, name, email, role, TRUE AS is_active
        `;

    const userResult = await client.query<{
      id: number;
      name: string;
      email: string;
      role: "admin";
      is_active: boolean;
    }>(userInsertSql, [name, email]);

    const createdUser = userResult.rows[0];
    const rawToken = generateToken();
    const lookupHash = sha256(rawToken);
    const hashedToken = await hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await client.query(
      `
        INSERT INTO password_setup_tokens (user_id, token, token_lookup_hash, expires_at, is_used)
        VALUES ($1, $2, $3, $4, FALSE)
      `,
      [createdUser.id, hashedToken, lookupHash, expiresAt]
    );

    await createAuditLogWithClient(client, {
      userId: input.actorUserId,
      action: "admin_user_created",
      entityType: "user",
      entityId: String(createdUser.id),
      metadata: {
        created_role: "admin",
        created_email: createdUser.email,
      },
    });

    await client.query("COMMIT");

    return {
      id: String(createdUser.id),
      name: createdUser.name,
      email: createdUser.email,
      role: createdUser.role,
      is_active: Boolean(createdUser.is_active),
      setup_link: buildAdminSetupLink(rawToken),
      setup_token_expires_at: expiresAt.toISOString(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
