import type { PoolClient } from "pg";
import pool from "../config/db";

export type ReceptionistPermissionFlags = {
  can_manage_queue: boolean;
  can_manage_appointments: boolean;
  can_check_in: boolean;
};

export type ReceptionistComputedStatus = "PENDING" | "ACTIVE" | "DISABLED";

type PermissionRow = {
  can_manage_queue: boolean | null;
  can_manage_appointments: boolean | null;
  can_check_in: boolean | null;
};

const DEFAULT_PERMISSIONS: ReceptionistPermissionFlags = {
  can_manage_queue: false,
  can_manage_appointments: false,
  can_check_in: false,
};

const mapPermissionRow = (row?: Partial<PermissionRow> | null): ReceptionistPermissionFlags => ({
  can_manage_queue: Boolean(row?.can_manage_queue),
  can_manage_appointments: Boolean(row?.can_manage_appointments),
  can_check_in: Boolean(row?.can_check_in),
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
        can_check_in
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
        can_check_in
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, medical_center_id)
      DO UPDATE SET
        can_manage_queue = EXCLUDED.can_manage_queue,
        can_manage_appointments = EXCLUDED.can_manage_appointments,
        can_check_in = EXCLUDED.can_check_in,
        updated_at = CURRENT_TIMESTAMP
      RETURNING
        can_manage_queue,
        can_manage_appointments,
        can_check_in
    `,
    [
      input.userId,
      input.medicalCenterId,
      input.permissions.can_manage_queue,
      input.permissions.can_manage_appointments,
      input.permissions.can_check_in,
    ]
  );

  return mapPermissionRow(result.rows[0]);
};
