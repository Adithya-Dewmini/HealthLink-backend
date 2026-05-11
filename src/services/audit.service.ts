import type { PoolClient } from "pg";
import type { Request } from "express";
import pool from "../config/db";
import type { AuthenticatedRequest } from "../types/auth";

type Queryable = {
  query: <TRow = any>(text: string, params?: unknown[]) => Promise<{ rows: TRow[] }>;
};

export type AuditLogInput = {
  actorUserId?: number | null;
  actorRole?: string | null;
  userId?: number | null;
  action: string;
  entityType?: string | null;
  entityId?: string | number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
};

const normalizeIpAddress = (value: string | undefined) => {
  const trimmed = String(value || "").trim();
  return trimmed || null;
};

const normalizeUserAgent = (value: string | undefined) => {
  const trimmed = String(value || "").trim();
  return trimmed || null;
};

const normalizeEntityId = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return null;
  const parsed = String(value).trim();
  return parsed || null;
};

const insertAuditLog = async (executor: Queryable, input: AuditLogInput) => {
  const actorUserId = input.actorUserId ?? input.userId ?? null;
  const metadata = input.metadata ?? {};

  await executor.query(
    `
      INSERT INTO audit_logs (
        actor_id,
        actor_user_id,
        actor_role,
        user_id,
        action,
        entity_type,
        entity_id,
        ip_address,
        user_agent,
        notes,
        metadata,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, NOW())
    `,
    [
      actorUserId,
      actorUserId,
      input.actorRole ?? null,
      input.userId ?? actorUserId,
      input.action,
      input.entityType ?? null,
      normalizeEntityId(input.entityId),
      input.ipAddress ?? null,
      input.userAgent ?? null,
      JSON.stringify(metadata),
      JSON.stringify(metadata),
    ]
  );
};

export const getAuditRequestContext = (req: Request | AuthenticatedRequest) => {
  const typedReq = req as AuthenticatedRequest;
  return {
    actorUserId:
      typeof typedReq.user?.id === "number" && Number.isInteger(typedReq.user.id)
        ? typedReq.user.id
        : null,
    actorRole: typeof typedReq.user?.role === "string" ? typedReq.user.role : null,
    ipAddress: normalizeIpAddress(req.ip || req.socket?.remoteAddress),
    userAgent: normalizeUserAgent(req.headers["user-agent"]),
  };
};

export const createAuditLog = async (input: AuditLogInput) => {
  await insertAuditLog(pool, input);
};

export const createAuditLogWithClient = async (
  client: PoolClient | Queryable,
  input: AuditLogInput
) => {
  await insertAuditLog(client, input);
};
