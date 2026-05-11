import pool from "../config/db";
import { emitNotificationCreated } from "./realtime.service";
import { filterExpoTokens, sendExpoPush } from "../utils/expoPush";

export type CreateNotificationInput = {
  userId: number;
  title: string;
  body: string;
  type: string;
  metadata?: Record<string, unknown>;
};

export const registerPushToken = async (input: {
  userId: number;
  role: string | null;
  expoPushToken: string;
  devicePlatform?: string | null;
  deviceName?: string | null;
  deviceModel?: string | null;
  appVersion?: string | null;
}) => {
  const { rows } = await pool.query(
    `
      INSERT INTO push_tokens (
        user_id,
        role,
        expo_push_token,
        device_platform,
        device_name,
        device_model,
        app_version,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      ON CONFLICT (user_id, expo_push_token)
      DO UPDATE SET
        role = EXCLUDED.role,
        device_platform = EXCLUDED.device_platform,
        device_name = EXCLUDED.device_name,
        device_model = EXCLUDED.device_model,
        app_version = EXCLUDED.app_version,
        updated_at = NOW()
      RETURNING id
    `,
    [
      input.userId,
      input.role,
      input.expoPushToken,
      input.devicePlatform ?? null,
      input.deviceName ?? null,
      input.deviceModel ?? null,
      input.appVersion ?? null,
    ]
  );

  return { id: Number(rows[0]?.id ?? 0) };
};

export const createStoredNotification = async (input: CreateNotificationInput) => {
  const { rows } = await pool.query(
    `
      INSERT INTO notifications (
        user_id,
        title,
        body,
        type,
        is_read,
        metadata,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, FALSE, $5::jsonb, NOW(), NOW())
      RETURNING id
    `,
    [input.userId, input.title, input.body, input.type, JSON.stringify(input.metadata ?? {})]
  );

  const notification = {
    id: Number(rows[0]?.id ?? 0),
    title: input.title,
    body: input.body,
    type: input.type,
    isRead: false,
    metadata: input.metadata ?? {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  emitNotificationCreated({
    userId: input.userId,
    notification,
  });

  return notification;
};

export const createNotificationAndPush = async (input: CreateNotificationInput) => {
  const notification = await createStoredNotification(input);
  const tokenResult = await pool.query<{ expo_push_token: string | null }>(
    `
      SELECT expo_push_token
      FROM push_tokens
      WHERE user_id = $1
      ORDER BY updated_at DESC
    `,
    [input.userId]
  );

  const tokens = filterExpoTokens(tokenResult.rows.map((row) => row.expo_push_token));
  if (tokens.length) {
    await sendExpoPush(
      tokens.map((token) => ({
        to: token,
        title: input.title,
        body: input.body,
        data: {
          type: input.type,
          notificationId: notification.id,
          ...(input.metadata ?? {}),
        },
      }))
    );
  }

  return notification;
};

export const getPharmacyMemberUserIds = async (pharmacyId: number) => {
  const result = await pool.query<{ user_id: number }>(
    `
      SELECT user_id
      FROM pharmacist_pharmacies
      WHERE pharmacy_id = $1
    `,
    [pharmacyId]
  );

  return result.rows
    .map((row) => Number(row.user_id))
    .filter((value) => Number.isInteger(value) && value > 0);
};

export const listNotificationsForUser = async (
  userId: number,
  pagination: { limit: number; offset: number; page: number } = { limit: 50, offset: 0, page: 1 }
) => {
  const [listResult, unreadResult] = await Promise.all([
    pool.query(
      `
      SELECT id, title, body, type, is_read, metadata, created_at, updated_at
      FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3
    `,
      [userId, pagination.limit, pagination.offset]
    ),
    pool.query<{ count: number }>(
      `
      SELECT COUNT(*)::int AS count
      FROM notifications
      WHERE user_id = $1
        AND is_read = FALSE
    `,
      [userId]
    ),
  ]);

  return {
    page: pagination.page,
    limit: pagination.limit,
    unreadCount: Number(unreadResult.rows[0]?.count ?? 0),
    notifications: listResult.rows.map((row) => ({
      id: Number(row.id),
      title: row.title,
      body: row.body,
      type: row.type,
      isRead: Boolean(row.is_read),
      metadata: row.metadata ?? {},
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
  };
};

export const markNotificationRead = async (userId: number, notificationId: number) => {
  const { rows } = await pool.query(
    `
      UPDATE notifications
      SET is_read = TRUE, updated_at = NOW()
      WHERE id = $1
        AND user_id = $2
      RETURNING id, title, body, type, is_read, metadata, created_at, updated_at
    `,
    [notificationId, userId]
  );

  if (!rows.length) {
    const error = new Error("Notification not found") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }

  const row = rows[0];
  return {
    notification: {
      id: Number(row.id),
      title: row.title,
      body: row.body,
      type: row.type,
      isRead: Boolean(row.is_read),
      metadata: row.metadata ?? {},
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    },
  };
};
