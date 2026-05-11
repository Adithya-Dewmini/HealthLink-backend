import pool from "../../config/db";
import { fetchPharmacyProfileByUserId } from "../pharmacy/service";
import { HttpError } from "../pharmacy/errors";
import type { ActivityFeedResponse, ActivityLogEntry } from "./types";

type DbRow = Record<string, any>;

const normalizeActivityLog = (row: DbRow): ActivityLogEntry => ({
  id: Number(row.id),
  userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
  orderId: row.order_id === null || row.order_id === undefined ? null : Number(row.order_id),
  prescriptionId:
    row.prescription_id === null || row.prescription_id === undefined
      ? null
      : String(row.prescription_id),
  queueId: row.queue_id === null || row.queue_id === undefined ? null : Number(row.queue_id),
  type: String(row.type ?? "activity"),
  title: String(row.title ?? "Activity"),
  description: typeof row.description === "string" ? row.description : null,
  metadata:
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {},
  createdAt: new Date(row.created_at).toISOString(),
});

export const recordActivityLog = async (input: {
  userId?: number | null;
  orderId?: number | null;
  prescriptionId?: string | null;
  queueId?: number | null;
  type: string;
  title: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}) => {
  const { rows } = await pool.query(
    `
      INSERT INTO activity_logs (
        user_id,
        order_id,
        prescription_id,
        queue_id,
        type,
        title,
        description,
        metadata,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
      RETURNING id, user_id, order_id, prescription_id, queue_id, type, title, description, metadata, created_at
    `,
    [
      input.userId ?? null,
      input.orderId ?? null,
      input.prescriptionId ?? null,
      input.queueId ?? null,
      input.type,
      input.title,
      input.description ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  );

  return normalizeActivityLog(rows[0] ?? {});
};

export const listMyActivityFeed = async (
  userId: number,
  pagination: { page: number; limit: number; offset: number }
): Promise<ActivityFeedResponse> => {
  const { rows } = await pool.query(
    `
      SELECT id, user_id, order_id, prescription_id, queue_id, type, title, description, metadata, created_at
      FROM activity_logs
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3
    `,
    [userId, pagination.limit, pagination.offset]
  );

  return {
    page: pagination.page,
    limit: pagination.limit,
    items: rows.map(normalizeActivityLog),
  };
};

export const getPatientOrderTimeline = async (patientId: number, orderId: number) => {
  const ownership = await pool.query(
    `
      SELECT id
      FROM orders
      WHERE id = $1 AND patient_id = $2
      LIMIT 1
    `,
    [orderId, patientId]
  );

  if (!ownership.rows.length) {
    throw new HttpError(404, "Order not found");
  }

  const result = await pool.query(
    `
      SELECT id, user_id, order_id, prescription_id, queue_id, type, title, description, metadata, created_at
      FROM activity_logs
      WHERE order_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [orderId]
  );

  return {
    timeline: result.rows.map(normalizeActivityLog),
  };
};

export const getPharmacyOrderTimeline = async (pharmacistUserId: number, orderId: number) => {
  const pharmacy = await fetchPharmacyProfileByUserId(pharmacistUserId);
  const ownership = await pool.query(
    `
      SELECT id
      FROM orders
      WHERE id = $1 AND pharmacy_id = $2
      LIMIT 1
    `,
    [orderId, pharmacy.id]
  );

  if (!ownership.rows.length) {
    throw new HttpError(404, "Order not found");
  }

  const result = await pool.query(
    `
      SELECT id, user_id, order_id, prescription_id, queue_id, type, title, description, metadata, created_at
      FROM activity_logs
      WHERE order_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [orderId]
  );

  return {
    timeline: result.rows.map(normalizeActivityLog),
  };
};
