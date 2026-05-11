import pool from "../config/db";

type AuditActionType = "approval" | "rejection" | "activation" | "deactivation" | "update";

type ListAuditLogsOptions = {
  actorId?: number;
  role?: string;
  action?: string;
  entityType?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
};

type AuditLogListRow = {
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  actor_id: number | null;
  actor_role: string | null;
  ip_address: string | null;
  user_agent: string | null;
  actor_name: string | null;
  actor_email: string | null;
  created_at: string;
  notes_preview: string | null;
  metadata: Record<string, unknown> | null;
};

type AuditLogDetailRow = AuditLogListRow & {
  related_entity_name: string | null;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const toActionLabel = (action: string) =>
  action
    .trim()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());

const resolveActionType = (action: string): AuditActionType => {
  const normalized = action.toLowerCase();
  if (normalized.includes("approve")) return "approval";
  if (normalized.includes("reject")) return "rejection";
  if (normalized.includes("deactivat") || normalized.includes("disable")) return "deactivation";
  if (normalized.includes("activat") || normalized.includes("enable")) return "activation";
  return "update";
};

const normalizePositiveInteger = (value: number | undefined, fallback: number, max?: number) => {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return typeof max === "number" ? Math.min(value, max) : value;
};

const buildAuditWhereClause = (options: ListAuditLogsOptions) => {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (typeof options.actorId === "number" && Number.isInteger(options.actorId) && options.actorId > 0) {
    params.push(options.actorId);
    clauses.push(`COALESCE(al.actor_user_id, al.actor_id, al.user_id) = $${params.length}`);
  }

  if (typeof options.role === "string" && options.role.trim().length > 0) {
    params.push(options.role.trim());
    clauses.push(`LOWER(COALESCE(al.actor_role, '')) = LOWER($${params.length})`);
  }

  if (typeof options.action === "string" && options.action.trim().length > 0) {
    params.push(options.action.trim());
    clauses.push(`LOWER(al.action) = LOWER($${params.length})`);
  }

  if (typeof options.entityType === "string" && options.entityType.trim().length > 0) {
    params.push(options.entityType.trim());
    clauses.push(`LOWER(COALESCE(al.entity_type, '')) = LOWER($${params.length})`);
  }

  if (typeof options.startDate === "string" && options.startDate.trim().length > 0) {
    params.push(options.startDate.trim());
    clauses.push(`al.created_at >= $${params.length}::timestamptz`);
  }

  if (typeof options.endDate === "string" && options.endDate.trim().length > 0) {
    params.push(options.endDate.trim());
    clauses.push(`al.created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
};

const listSelectSql = `
  SELECT
    al.id::text AS id,
    al.action,
    al.entity_type,
    al.entity_id,
    COALESCE(al.actor_user_id, al.actor_id, al.user_id) AS actor_id,
    al.actor_role,
    al.ip_address,
    al.user_agent,
    actor.name AS actor_name,
    actor.email AS actor_email,
    al.created_at::text AS created_at,
    CASE
      WHEN jsonb_typeof(COALESCE(al.metadata, al.notes)) = 'object' THEN COALESCE(COALESCE(al.metadata, al.notes) ->> 'note', COALESCE(al.metadata, al.notes)::text)
      ELSE COALESCE(al.metadata, al.notes)::text
    END AS notes_preview,
    COALESCE(al.metadata, al.notes) AS metadata
  FROM audit_logs al
  LEFT JOIN users actor ON actor.id = COALESCE(al.actor_user_id, al.actor_id, al.user_id)
`;

const detailSelectSql = `
  SELECT
    al.id::text AS id,
    al.action,
    al.entity_type,
    al.entity_id,
    COALESCE(al.actor_user_id, al.actor_id, al.user_id) AS actor_id,
    al.actor_role,
    al.ip_address,
    al.user_agent,
    actor.name AS actor_name,
    actor.email AS actor_email,
    al.created_at::text AS created_at,
    CASE
      WHEN jsonb_typeof(COALESCE(al.metadata, al.notes)) = 'object' THEN COALESCE(COALESCE(al.metadata, al.notes) ->> 'note', COALESCE(al.metadata, al.notes)::text)
      ELSE COALESCE(al.metadata, al.notes)::text
    END AS notes_preview,
    COALESCE(al.metadata, al.notes) AS metadata,
    CASE
      WHEN LOWER(COALESCE(al.entity_type, '')) = 'clinic' THEN mc.name
      WHEN LOWER(COALESCE(al.entity_type, '')) = 'doctor' THEN COALESCE(doctor_user.name, d.specialization, 'Doctor')
      WHEN LOWER(COALESCE(al.entity_type, '')) = 'pharmacy' THEN p.name
      WHEN LOWER(COALESCE(al.entity_type, '')) = 'user' THEN related_user.name
      ELSE NULL
    END AS related_entity_name
  FROM audit_logs al
  LEFT JOIN users actor ON actor.id = COALESCE(al.actor_user_id, al.actor_id, al.user_id)
  LEFT JOIN medical_centers mc
    ON LOWER(COALESCE(al.entity_type, '')) = 'clinic'
   AND mc.id::text = al.entity_id
  LEFT JOIN doctors d
    ON LOWER(COALESCE(al.entity_type, '')) = 'doctor'
   AND d.id::text = al.entity_id
  LEFT JOIN users doctor_user ON doctor_user.id = d.user_id
  LEFT JOIN pharmacies p
    ON LOWER(COALESCE(al.entity_type, '')) = 'pharmacy'
   AND p.id::text = al.entity_id
  LEFT JOIN users related_user
    ON LOWER(COALESCE(al.entity_type, '')) = 'user'
   AND related_user.id::text = al.entity_id
`;

export const listAdminAuditLogs = async (options: ListAuditLogsOptions = {}) => {
  const page = normalizePositiveInteger(options.page, DEFAULT_PAGE);
  const pageSize = normalizePositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const { whereSql, params } = buildAuditWhereClause(options);

  const listParams = [...params, pageSize, offset];
  const countParams = [...params];

  const [listResult, countResult, actorOptionsResult, roleOptionsResult, actionOptionsResult, entityTypeOptionsResult] =
    await Promise.all([
      pool.query<AuditLogListRow>(
        `
        ${listSelectSql}
        ${whereSql}
        ORDER BY al.created_at DESC
        LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
        `,
        listParams
      ),
      pool.query<{ count: number }>(
        `
        SELECT COUNT(*)::int AS count
        FROM audit_logs al
        ${whereSql}
        `,
        countParams
      ),
      pool.query<{ id: number; name: string | null; email: string | null }>(
        `
        SELECT DISTINCT
          actor.id,
          actor.name,
          actor.email
        FROM audit_logs al
        JOIN users actor ON actor.id = COALESCE(al.actor_user_id, al.actor_id, al.user_id)
        WHERE actor.id IS NOT NULL
        ORDER BY actor.name ASC NULLS LAST, actor.email ASC NULLS LAST
        `
      ),
      pool.query<{ actor_role: string }>(
        `
        SELECT DISTINCT al.actor_role
        FROM audit_logs al
        WHERE COALESCE(al.actor_role, '') <> ''
        ORDER BY al.actor_role ASC
        `
      ),
      pool.query<{ action: string }>(
        `
        SELECT DISTINCT al.action
        FROM audit_logs al
        WHERE COALESCE(al.action, '') <> ''
        ORDER BY al.action ASC
        `
      ),
      pool.query<{ entity_type: string }>(
        `
        SELECT DISTINCT al.entity_type
        FROM audit_logs al
        WHERE COALESCE(al.entity_type, '') <> ''
        ORDER BY al.entity_type ASC
        `
      ),
    ]);

  const total = countResult.rows[0]?.count ?? 0;
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;

  return {
    items: listResult.rows.map((row) => ({
      id: row.id,
      action: row.action,
      action_label: toActionLabel(row.action),
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      actor: row.actor_id
        ? {
            id: row.actor_id,
            name: row.actor_name,
            email: row.actor_email,
          }
        : null,
      actor_id: row.actor_id,
      actor_role: row.actor_role,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      actor_name: row.actor_name,
      actor_email: row.actor_email,
      timestamp: row.created_at,
      created_at: row.created_at,
      notes_preview: row.notes_preview,
      metadata: row.metadata,
      context: row.metadata,
      description: row.notes_preview,
      action_type: resolveActionType(row.action),
    })),
    pagination: {
      total,
      page,
      pageSize,
      totalPages,
    },
    filter_options: {
      actors: actorOptionsResult.rows.map((row) => ({
        id: row.id,
        name: row.name || row.email || `User #${row.id}`,
        email: row.email || undefined,
      })),
      roles: roleOptionsResult.rows.map((row) => row.actor_role),
      actions: actionOptionsResult.rows.map((row) => row.action),
      entity_types: entityTypeOptionsResult.rows.map((row) => row.entity_type),
    },
  };
};

export const getAdminAuditLogDetail = async (id: string) => {
  const result = await pool.query<AuditLogDetailRow>(
    `
    ${detailSelectSql}
    WHERE al.id = $1::uuid
    LIMIT 1
    `,
    [id]
  );

  const row = result.rows[0];
  if (!row) {
    const error = new Error("Audit log not found") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }

  return {
    id: row.id,
    action: row.action,
    action_label: toActionLabel(row.action),
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    actor: row.actor_id
      ? {
          id: row.actor_id,
          name: row.actor_name,
          email: row.actor_email,
        }
      : null,
    actor_id: row.actor_id,
    actor_role: row.actor_role,
    ip_address: row.ip_address,
    user_agent: row.user_agent,
    actor_name: row.actor_name,
    actor_email: row.actor_email,
    timestamp: row.created_at,
    created_at: row.created_at,
    notes_preview: row.notes_preview,
    metadata: row.metadata,
    context: row.metadata,
    description: row.notes_preview,
    action_type: resolveActionType(row.action),
    notes: row.metadata,
    related_entity: row.entity_id
      ? {
          id: row.entity_id,
          type: row.entity_type || "unknown",
          name: row.related_entity_name,
        }
      : null,
  };
};
