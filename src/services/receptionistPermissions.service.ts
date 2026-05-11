import type { PoolClient } from "pg";
import pool from "../config/db";

export type ReceptionistPermissionFlags = {
  can_manage_queue: boolean;
  can_manage_appointments: boolean;
  can_check_in: boolean;
  schedule_management: boolean;
};

export type ReceptionistPermissionContract = {
  queue_access: boolean;
  appointments: boolean;
  check_in: boolean;
  schedule_management: boolean;
};

export type ReceptionistComputedStatus = "PENDING" | "ACTIVE" | "DISABLED";

type PermissionRow = {
  can_manage_queue: boolean | null;
  can_manage_appointments: boolean | null;
  can_check_in: boolean | null;
  schedule_management: boolean | null;
};

const DEFAULT_PERMISSIONS: ReceptionistPermissionFlags = {
  can_manage_queue: false,
  can_manage_appointments: false,
  can_check_in: false,
  schedule_management: false,
};

const mapPermissionRow = (row?: Partial<PermissionRow> | null): ReceptionistPermissionFlags => ({
  can_manage_queue: Boolean(row?.can_manage_queue),
  can_manage_appointments: Boolean(row?.can_manage_appointments),
  can_check_in: Boolean(row?.can_check_in),
  schedule_management: Boolean(row?.schedule_management),
});

export const toReceptionistPermissionContract = (
  permissions?: Partial<ReceptionistPermissionFlags> | null
): ReceptionistPermissionContract => ({
  queue_access: Boolean(permissions?.can_manage_queue),
  appointments: Boolean(permissions?.can_manage_appointments),
  check_in: Boolean(permissions?.can_check_in),
  schedule_management: Boolean(permissions?.schedule_management),
});

export const fromReceptionistPermissionContract = (
  value?: Partial<ReceptionistPermissionContract & ReceptionistPermissionFlags> | null
): ReceptionistPermissionFlags => ({
  can_manage_queue: Boolean(value?.queue_access ?? value?.can_manage_queue),
  can_manage_appointments: Boolean(value?.appointments ?? value?.can_manage_appointments),
  can_check_in: Boolean(value?.check_in ?? value?.can_check_in),
  schedule_management: Boolean(value?.schedule_management),
});

export const computeReceptionistStatus = (
  isPasswordSet: boolean,
  centerStatus: string | null | undefined
): ReceptionistComputedStatus => {
  if (!isPasswordSet) {
    return "PENDING";
  }

  if (String(centerStatus || "").trim().toUpperCase() === "INACTIVE") {
    return "DISABLED";
  }

  return "ACTIVE";
};

export const getDefaultReceptionistPermissions = () => ({ ...DEFAULT_PERMISSIONS });

export const getReceptionistPermissionsByUserId = async (
  userId: number,
  medicalCenterId: string,
  client?: PoolClient
) => {
  const executor = client ?? pool;
  const result = await executor.query<PermissionRow>(
    `
      SELECT
        can_manage_queue,
        can_manage_appointments,
        can_check_in,
        schedule_management
      FROM receptionist_permissions
      WHERE user_id = $1
        AND medical_center_id = $2
      LIMIT 1
    `,
    [userId, medicalCenterId]
  );

  return result.rows[0] ? mapPermissionRow(result.rows[0]) : getDefaultReceptionistPermissions();
};

export const upsertReceptionistPermissions = async (
  input: {
    userId: number;
    medicalCenterId: string;
    permissions: ReceptionistPermissionFlags;
  },
  client?: PoolClient
) => {
  const executor = client ?? pool;
  const result = await executor.query<PermissionRow>(
    `
      INSERT INTO receptionist_permissions (
        user_id,
        medical_center_id,
        can_manage_queue,
        can_manage_appointments,
        can_check_in,
        schedule_management
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, medical_center_id)
      DO UPDATE SET
        can_manage_queue = EXCLUDED.can_manage_queue,
        can_manage_appointments = EXCLUDED.can_manage_appointments,
        can_check_in = EXCLUDED.can_check_in,
        schedule_management = EXCLUDED.schedule_management,
        updated_at = CURRENT_TIMESTAMP
      RETURNING
        can_manage_queue,
        can_manage_appointments,
        can_check_in,
        schedule_management
    `,
    [
      input.userId,
      input.medicalCenterId,
      input.permissions.can_manage_queue,
      input.permissions.can_manage_appointments,
      input.permissions.can_check_in,
      input.permissions.schedule_management,
    ]
  );

  return mapPermissionRow(result.rows[0]);
};
