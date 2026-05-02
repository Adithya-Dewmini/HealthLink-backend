import type { PoolClient } from "pg";
import pool from "../config/db";
import { env } from "../config/env";
import { createAuditLogWithClient } from "./audit.service";
import { sendReceptionistInviteEmail } from "./email.service";
import { generateToken, hashToken, sha256 } from "../utils/security";
import {
  computeReceptionistStatus,
  getDefaultReceptionistPermissions,
  getReceptionistPermissionsByUserId,
  type ReceptionistPermissionFlags,
  upsertReceptionistPermissions,
} from "./receptionistPermissions.service";

type AppError = Error & { statusCode?: number };
type ReceptionistRecordRow = {
  id: number;
  user_id: number;
  name: string;
  email: string;
  phone: string | null;
  is_password_set: boolean;
  created_at: string;
  center_status: string | null;
};

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const normalizePhone = (value: unknown) => {
  const phone = String(value || "").trim();
  return phone.length > 0 ? phone : null;
};
const normalizeStatus = (value: unknown) => String(value || "").trim().toUpperCase();

const normalizePermissionsInput = (
  value: Partial<ReceptionistPermissionFlags> | null | undefined
): ReceptionistPermissionFlags => ({
  can_manage_queue: Boolean(value?.can_manage_queue),
  can_manage_appointments: Boolean(value?.can_manage_appointments),
  can_check_in: Boolean(value?.can_check_in),
});

const validateEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
};

const getMobileScheme = (mobileScheme?: string) => String(mobileScheme || env.mobileAppScheme).trim();

const getWebBaseUrl = (webBaseUrl?: string) => {
  const value =
    webBaseUrl?.trim() ||
    env.appWebUrl?.trim() ||
    env.publicAppUrl?.trim() ||
    env.receptionistSetupUrl?.trim();

  return value ? value.replace(/\/$/, "") : null;
};

const buildInviteLinks = (input: {
  rawToken: string;
  webBaseUrl?: string;
  mobileScheme?: string;
}) => {
  const scheme = getMobileScheme(input.mobileScheme);
  const webBaseUrl = getWebBaseUrl(input.webBaseUrl);
  const setupLink = `${scheme}://set-password?token=${input.rawToken}`;

  return {
    setupLink,
    webLink: webBaseUrl ? `${webBaseUrl}/setup-password?token=${input.rawToken}` : setupLink,
  };
};

const createPasswordSetupToken = async (client: PoolClient, userId: number) => {
  const rawToken = generateToken();
  const lookupHash = sha256(rawToken);
  const hashedToken = await hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await client.query(
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

const mapReceptionistRecord = async (
  row: ReceptionistRecordRow,
  medicalCenterId: string,
  client?: PoolClient
) => {
  const permissions = await getReceptionistPermissionsByUserId(row.user_id, medicalCenterId, client);

  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    is_password_set: Boolean(row.is_password_set),
    status: computeReceptionistStatus(Boolean(row.is_password_set), row.center_status),
    created_at: row.created_at,
    permissions,
  };
};

const getReceptionistRecordById = async (
  client: PoolClient,
  medicalCenterId: string,
  receptionistId: number
) => {
  const result = await client.query<ReceptionistRecordRow>(
    `
      SELECT
        r.id,
        r.user_id,
        u.name,
        u.email,
        r.phone,
        u.is_password_set,
        r.created_at,
        mcu.status AS center_status
      FROM receptionists r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN medical_center_users mcu
        ON mcu.user_id = r.user_id
       AND mcu.medical_center_id = r.medical_center_id
       AND LOWER(mcu.role) = 'receptionist'
      WHERE r.id = $1
        AND r.medical_center_id = $2
      LIMIT 1
    `,
    [receptionistId, medicalCenterId]
  );

  return result.rows[0] ?? null;
};

const requireValidReceptionistId = (value: string | number) => {
  const receptionistId = Number(value);

  if (!Number.isFinite(receptionistId) || receptionistId <= 0) {
    throw createStatusError("Invalid receptionist id", 400);
  }

  return receptionistId;
};

export const listReceptionistsByMedicalCenter = async (medicalCenterId: string) => {
  const result = await pool.query<ReceptionistRecordRow>(
    `
      SELECT
        r.id,
        u.id AS user_id,
        u.name,
        u.email,
        r.phone,
        u.is_password_set,
        r.created_at,
        mcu.status AS center_status
      FROM receptionists r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN medical_center_users mcu
        ON mcu.user_id = r.user_id
       AND mcu.medical_center_id = r.medical_center_id
       AND LOWER(mcu.role) = 'receptionist'
      WHERE r.medical_center_id = $1
      ORDER BY r.created_at DESC, u.name ASC
    `,
    [medicalCenterId]
  );

  return Promise.all(result.rows.map((row) => mapReceptionistRecord(row, medicalCenterId)));
};

export const createReceptionistForMedicalCenter = async (input: {
  medicalCenterId: string;
  name: string;
  email: string;
  phone?: string;
  webBaseUrl?: string;
  mobileScheme?: string;
}) => {
  const name = String(input.name || "").trim();
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);

  if (!name || !email) {
    throw createStatusError("name and email are required", 400);
  }

  if (!validateEmail(email)) {
    throw createStatusError("Valid email is required", 400);
  }

  const client = await pool.connect();
  let inviteEmailPayload: { to: string; clinicName: string; role: string; webLink: string } | null = null;
  let responsePayload:
    | {
        message: string;
        receptionist: Awaited<ReturnType<typeof mapReceptionistRecord>>;
        setupLink: string;
        webLink: string;
        expiresAt: string;
        emailSent: boolean;
        emailError: string | null;
      }
    | null = null;

  try {
    await client.query("BEGIN");

    const centerResult = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM medical_centers WHERE id = $1 LIMIT 1`,
      [input.medicalCenterId]
    );

    if (centerResult.rows.length === 0) {
      throw createStatusError("Medical center not found", 404);
    }

    const existingUser = await client.query(`SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`, [
      email,
    ]);

    if (existingUser.rows.length > 0) {
      throw createStatusError("User already exists", 409);
    }

    const userResult = await client.query<{
      id: number;
      name: string;
      email: string;
      role: string;
      is_password_set: boolean;
    }>(
      `
        INSERT INTO users (
          name,
          email,
          password,
          password_hash,
          is_password_set,
          role
        )
        VALUES ($1, $2, NULL, NULL, FALSE, 'receptionist')
        RETURNING id, name, email, role, is_password_set
      `,
      [name, email]
    );

    const user = userResult.rows[0];

    const receptionistResult = await client.query<{
      id: number;
      medical_center_id: string;
      created_at: string;
    }>(
      `
        INSERT INTO receptionists (user_id, phone, medical_center_id)
        VALUES ($1, $2, $3)
        RETURNING id, medical_center_id, created_at
      `,
      [user.id, phone, input.medicalCenterId]
    );

    await client.query(
      `
        INSERT INTO medical_center_users (user_id, medical_center_id, role, status)
        VALUES ($1, $2, 'RECEPTIONIST', 'ACTIVE')
      `,
      [user.id, input.medicalCenterId]
    );

    await upsertReceptionistPermissions(
      {
        userId: user.id,
        medicalCenterId: input.medicalCenterId,
        permissions: getDefaultReceptionistPermissions(),
      },
      client
    );

    const { rawToken, expiresAt } = await createPasswordSetupToken(client, user.id);
    const links = buildInviteLinks({
      rawToken,
      webBaseUrl: input.webBaseUrl,
      mobileScheme: input.mobileScheme,
    });

    inviteEmailPayload = {
      to: user.email,
      clinicName: centerResult.rows[0].name,
      role: "Receptionist",
      webLink: links.webLink,
    };

    await createAuditLogWithClient(client, {
      userId: user.id,
      action: "receptionist_created",
    });

    await client.query("COMMIT");

    responsePayload = {
      message: "Receptionist created successfully",
      receptionist: {
        id: receptionistResult.rows[0].id,
        user_id: user.id,
        name: user.name,
        email: user.email,
        phone,
        is_password_set: false,
        status: "PENDING",
        created_at: receptionistResult.rows[0].created_at,
        permissions: getDefaultReceptionistPermissions(),
      },
      setupLink: links.setupLink,
      webLink: links.webLink,
      expiresAt,
      emailSent: false,
      emailError: null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (inviteEmailPayload) {
    try {
      await sendReceptionistInviteEmail(inviteEmailPayload);
      responsePayload!.emailSent = true;
    } catch (error) {
      console.log("Send receptionist invite email error:", error);
      responsePayload!.emailError =
        error instanceof Error ? error.message : "Failed to send invite email";
    }
  }

  return responsePayload!;
};

export const resendReceptionistInvite = async (input: {
  medicalCenterId: string;
  receptionistId: string | number;
  webBaseUrl?: string;
  mobileScheme?: string;
}) => {
  const receptionistId = requireValidReceptionistId(input.receptionistId);
  const client = await pool.connect();
  let inviteEmailPayload: { to: string; clinicName: string; role: string; webLink: string } | null = null;
  let responsePayload:
    | {
        message: string;
        receptionist: Record<string, unknown>;
        setupLink: string;
        webLink: string;
        expiresAt: string;
        emailSent: boolean;
        emailError: string | null;
      }
    | null = null;

  try {
    await client.query("BEGIN");

    const receptionistResult = await client.query<ReceptionistRecordRow & { medical_center_name: string }>(
      `
        SELECT
          r.id,
          r.user_id,
          u.name,
          u.email,
          r.phone,
          u.is_password_set,
          r.created_at,
          mcu.status AS center_status,
          mc.name AS medical_center_name
        FROM receptionists r
        JOIN users u ON u.id = r.user_id
        JOIN medical_centers mc ON mc.id = r.medical_center_id
        LEFT JOIN medical_center_users mcu
          ON mcu.user_id = r.user_id
         AND mcu.medical_center_id = r.medical_center_id
         AND LOWER(mcu.role) = 'receptionist'
        WHERE r.id = $1
          AND r.medical_center_id = $2
        LIMIT 1
      `,
      [receptionistId, input.medicalCenterId]
    );

    if (receptionistResult.rows.length === 0) {
      throw createStatusError("Receptionist not found", 404);
    }

    const receptionist = receptionistResult.rows[0];
    const status = computeReceptionistStatus(
      Boolean(receptionist.is_password_set),
      receptionist.center_status
    );

    if (status !== "PENDING") {
      throw createStatusError("Invite can only be resent while receptionist is pending", 400);
    }

    await client.query(`UPDATE password_setup_tokens SET is_used = TRUE WHERE user_id = $1`, [
      receptionist.user_id,
    ]);

    const { rawToken, expiresAt } = await createPasswordSetupToken(client, receptionist.user_id);
    const links = buildInviteLinks({
      rawToken,
      webBaseUrl: input.webBaseUrl,
      mobileScheme: input.mobileScheme,
    });

    inviteEmailPayload = {
      to: receptionist.email,
      clinicName: receptionist.medical_center_name,
      role: "Receptionist",
      webLink: links.webLink,
    };

    await createAuditLogWithClient(client, {
      userId: receptionist.user_id,
      action: "receptionist_invite_resent",
    });

    await client.query("COMMIT");

    responsePayload = {
      message: "Setup invite resent successfully",
      receptionist: {
        id: receptionist.id,
        user_id: receptionist.user_id,
        name: receptionist.name,
        email: receptionist.email,
        status,
      },
      setupLink: links.setupLink,
      webLink: links.webLink,
      expiresAt,
      emailSent: false,
      emailError: null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (inviteEmailPayload) {
    try {
      await sendReceptionistInviteEmail(inviteEmailPayload);
      responsePayload!.emailSent = true;
    } catch (error) {
      console.log("Resend receptionist invite email error:", error);
      responsePayload!.emailError =
        error instanceof Error ? error.message : "Failed to resend invite email";
    }
  }

  return responsePayload!;
};

export const updateReceptionistStatus = async (input: {
  medicalCenterId: string;
  receptionistId: string | number;
  status: string;
}) => {
  const receptionistId = requireValidReceptionistId(input.receptionistId);
  const status = normalizeStatus(input.status);

  if (!["ACTIVE", "INACTIVE"].includes(status)) {
    throw createStatusError("status must be ACTIVE or INACTIVE", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const receptionist = await getReceptionistRecordById(client, input.medicalCenterId, receptionistId);

    if (!receptionist) {
      throw createStatusError("Receptionist not found", 404);
    }

    if (status === "ACTIVE" && !receptionist.is_password_set) {
      throw createStatusError("Cannot enable receptionist before password setup is complete", 400);
    }

    const result = await client.query<{
      user_id: number;
      medical_center_id: string;
      status: string;
    }>(
      `
        UPDATE medical_center_users mcu
        SET status = $1
        FROM receptionists r
        WHERE r.user_id = mcu.user_id
          AND r.medical_center_id = mcu.medical_center_id
          AND r.id = $2
          AND r.medical_center_id = $3
          AND LOWER(mcu.role) = 'receptionist'
        RETURNING mcu.user_id, mcu.medical_center_id, mcu.status
      `,
      [status, receptionistId, input.medicalCenterId]
    );

    if (result.rows.length === 0) {
      throw createStatusError("Receptionist not found", 404);
    }

    await createAuditLogWithClient(client, {
      userId: result.rows[0].user_id,
      action: `receptionist_status_changed_${String(result.rows[0].status).toLowerCase()}`,
    });

    await client.query("COMMIT");

    return {
      message: status === "ACTIVE" ? "Receptionist enabled successfully" : "Receptionist disabled successfully",
      status: computeReceptionistStatus(Boolean(receptionist.is_password_set), result.rows[0].status),
      user_id: result.rows[0].user_id,
      medical_center_id: result.rows[0].medical_center_id,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getReceptionistPermissions = async (input: {
  medicalCenterId: string;
  receptionistId: string | number;
}) => {
  const receptionistId = requireValidReceptionistId(input.receptionistId);
  const client = await pool.connect();

  try {
    const receptionist = await getReceptionistRecordById(client, input.medicalCenterId, receptionistId);

    if (!receptionist) {
      throw createStatusError("Receptionist not found", 404);
    }

    const status = computeReceptionistStatus(
      Boolean(receptionist.is_password_set),
      receptionist.center_status
    );

    return {
      receptionist: {
        id: receptionist.id,
        user_id: receptionist.user_id,
        name: receptionist.name,
        email: receptionist.email,
        status,
        is_password_set: Boolean(receptionist.is_password_set),
      },
      permissions: await getReceptionistPermissionsByUserId(
        receptionist.user_id,
        input.medicalCenterId,
        client
      ),
    };
  } finally {
    client.release();
  }
};

export const updateReceptionistPermissions = async (input: {
  medicalCenterId: string;
  receptionistId: string | number;
  permissions: Partial<ReceptionistPermissionFlags>;
}) => {
  const receptionistId = requireValidReceptionistId(input.receptionistId);
  const permissions = normalizePermissionsInput(input.permissions);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const receptionist = await getReceptionistRecordById(client, input.medicalCenterId, receptionistId);

    if (!receptionist) {
      throw createStatusError("Receptionist not found", 404);
    }

    const status = computeReceptionistStatus(
      Boolean(receptionist.is_password_set),
      receptionist.center_status
    );

    if (status === "PENDING") {
      throw createStatusError("Cannot assign permissions while receptionist is pending", 400);
    }

    const updatedPermissions = await upsertReceptionistPermissions(
      {
        userId: receptionist.user_id,
        medicalCenterId: input.medicalCenterId,
        permissions,
      },
      client
    );

    await createAuditLogWithClient(client, {
      userId: receptionist.user_id,
      action: "receptionist_permissions_updated",
    });

    await client.query("COMMIT");

    return {
      message: "Receptionist permissions updated successfully",
      receptionist: {
        id: receptionist.id,
        user_id: receptionist.user_id,
        name: receptionist.name,
        email: receptionist.email,
        status,
        is_password_set: Boolean(receptionist.is_password_set),
      },
      permissions: updatedPermissions,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const removeReceptionistFromMedicalCenter = async (input: {
  medicalCenterId: string;
  receptionistId: string | number;
}) => {
  const receptionistId = requireValidReceptionistId(input.receptionistId);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const receptionist = await getReceptionistRecordById(client, input.medicalCenterId, receptionistId);

    if (!receptionist) {
      throw createStatusError("Receptionist not found or already removed", 404);
    }

    await client.query(
      `
        DELETE FROM receptionist_permissions
        WHERE user_id = $1
          AND medical_center_id = $2
      `,
      [receptionist.user_id, input.medicalCenterId]
    );

    await client.query(
      `
        DELETE FROM medical_center_users
        WHERE user_id = $1
          AND medical_center_id = $2
          AND LOWER(role) = 'receptionist'
      `,
      [receptionist.user_id, input.medicalCenterId]
    );

    await client.query(
      `
        UPDATE receptionists
        SET medical_center_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND medical_center_id = $2
      `,
      [receptionistId, input.medicalCenterId]
    );

    await createAuditLogWithClient(client, {
      userId: receptionist.user_id,
      action: "receptionist_removed_from_clinic",
    });

    await client.query("COMMIT");

    return {
      message: "Receptionist removed from clinic successfully",
      receptionist: {
        id: receptionist.id,
        user_id: receptionist.user_id,
        name: receptionist.name,
        email: receptionist.email,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getReceptionistPermissionsForAuth = async (
  userId: number,
  medicalCenterId: string | null
) => {
  if (!medicalCenterId) {
    return getDefaultReceptionistPermissions();
  }

  return getReceptionistPermissionsByUserId(userId, medicalCenterId);
};

export type { ReceptionistPermissionFlags };
