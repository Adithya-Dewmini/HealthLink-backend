import pool from "../config/db";
import { createAuditLogWithClient } from "./audit.service";
import type { JwtCenterMembership } from "../utils/security";
import type { PoolClient } from "pg";
import {
  comparePassword,
  compareToken,
  generateToken,
  hashPassword,
  hashToken,
  sha256,
  signAuthToken,
} from "../utils/security";
import { getDoctorCenterMembershipsForAuth } from "./doctorAssociation.service";
import { getReceptionistPermissionsForAuth } from "./receptionist.service";
import { toReceptionistPermissionContract } from "./receptionistPermissions.service";
import { env } from "../config/env";
import { sendPasswordResetEmail } from "./email.service";

type AppError = Error & { statusCode?: number };
type LoginUserRow = {
  id: number;
  name: string;
  email: string;
  role: string;
  password: string | null;
  password_hash: string | null;
  is_password_set: boolean;
  doctor_id: number | null;
  doctor_phone: string | null;
  doctor_specialization: string | null;
  doctor_experience_years: number | null;
  doctor_verification_status: string | null;
  doctor_verification_notes: string | null;
  admin_medical_center_id: string | null;
  admin_medical_center_verification_status: string | null;
  admin_medical_center_verification_notes: string | null;
  center_user_medical_center_id: string | null;
  center_user_status: string | null;
  active_doctor_center_medical_center_id: string | null;
  doctor_medical_center_id: string | null;
  receptionist_medical_center_id: string | null;
  receptionist_medical_center_verification_status: string | null;
  receptionist_medical_center_verification_notes: string | null;
  pharmacy_id: number | null;
  pharmacy_name: string | null;
  pharmacy_verification_status: string | null;
  pharmacy_verification_notes: string | null;
};
type MedicalCenterMembershipRow = {
  medical_center_id: string;
  role: string | null;
  status: string;
};
type PasswordSetupTokenRow = {
  id: string;
  user_id: number;
  token: string;
  expires_at: string | Date;
  is_used: boolean;
};

type PasswordResetUserRow = {
  id: number;
  name: string;
  email: string;
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
};

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();

const isBcryptHash = (value: unknown) =>
  typeof value === "string" && /^\$2[aby]\$/.test(value);

const getWebBaseUrl = () => {
  const value =
    env.appWebUrl?.trim() ||
    env.publicAppUrl?.trim() ||
    env.receptionistSetupUrl?.trim();

  return value ? value.replace(/\/$/, "") : null;
};

const buildPasswordResetLink = (token: string) => {
  const scheme = String(env.mobileAppScheme || "healthlink").trim();
  const webBaseUrl = getWebBaseUrl();
  return webBaseUrl
    ? `${webBaseUrl}/reset-password?token=${encodeURIComponent(token)}`
    : `${scheme}://reset-password?token=${encodeURIComponent(token)}`;
};

const findMatchingPasswordToken = async (client: PoolClient, token: string) => {
  const lookupHash = sha256(token);

  const tokenResultByLookupHash = await client.query<PasswordSetupTokenRow>(
    `
      SELECT pst.id, pst.user_id, pst.token, pst.expires_at, pst.is_used
      FROM password_setup_tokens pst
      WHERE pst.token_lookup_hash = $1::text
      ORDER BY pst.created_at DESC
    `,
    [lookupHash]
  );

  const tokenResultWithoutLookupHash =
    tokenResultByLookupHash.rows.length > 0
      ? { rows: [] as PasswordSetupTokenRow[] }
      : await client.query<PasswordSetupTokenRow>(
          `
            SELECT pst.id, pst.user_id, pst.token, pst.expires_at, pst.is_used
            FROM password_setup_tokens pst
            WHERE pst.token_lookup_hash IS NULL
            ORDER BY pst.created_at DESC
          `
        );

  const tokenRows = [...tokenResultByLookupHash.rows, ...tokenResultWithoutLookupHash.rows];

  for (const row of tokenRows) {
    if (isBcryptHash(row.token)) {
      if (await compareToken(token, row.token)) {
        return row;
      }
    } else if (row.token === token) {
      return row;
    }
  }

  return null;
};

const completePasswordSetupToken = async (input: {
  token: string;
  password: string;
  invalidTokenMessage: string;
  usedTokenMessage: string;
  expiredTokenMessage: string;
  successMessage: string;
  auditAction: string;
}) => {
  const token = String(input.token || "").trim();
  const password = String(input.password || "");

  if (!token || !password) {
    throw createStatusError("Token and password are required", 400);
  }

  if (password.length < 8) {
    throw createStatusError("Password must be at least 8 characters", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const matchingToken = await findMatchingPasswordToken(client, token);

    if (!matchingToken) {
      throw createStatusError(input.invalidTokenMessage, 400);
    }

    if (matchingToken.is_used) {
      throw createStatusError(input.usedTokenMessage, 400);
    }

    const expiresAt = new Date(matchingToken.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw createStatusError(input.expiredTokenMessage, 400);
    }

    const passwordHash = await hashPassword(password);

    await client.query(
      `
        UPDATE users
        SET
          password_hash = $1,
          password = $2,
          is_password_set = TRUE
        WHERE id = $3
      `,
      [passwordHash, passwordHash, matchingToken.user_id]
    );

    await client.query(
      `
        UPDATE password_setup_tokens
        SET is_used = TRUE
        WHERE user_id = $1
      `,
      [matchingToken.user_id]
    );

    await createAuditLogWithClient(client, {
      userId: matchingToken.user_id,
      action: input.auditAction,
    });

    await client.query("COMMIT");

    return { message: input.successMessage };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const resolveMedicalCenterId = (row: Record<string, unknown>) => {
  const candidates = [
    row.admin_medical_center_id,
    row.center_user_medical_center_id,
    row.active_doctor_center_medical_center_id,
    row.doctor_medical_center_id,
    row.receptionist_medical_center_id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
};

const normalizeVerificationStatus = (value: unknown) => {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized.length > 0 ? normalized : "pending";
};

const selectAuthContextSql = `
  SELECT
    u.id,
    u.name,
    u.email,
    u.role,
    u.password,
    u.password_hash,
    u.is_password_set,
    d.id AS doctor_id,
    d.phone AS doctor_phone,
    d.specialization AS doctor_specialization,
    d.experience_years AS doctor_experience_years,
    LOWER(COALESCE(d.verification_status, 'pending')) AS doctor_verification_status,
    d.verification_notes AS doctor_verification_notes,
    mca.medical_center_id AS admin_medical_center_id,
    LOWER(COALESCE(admin_center.verification_status, 'pending')) AS admin_medical_center_verification_status,
    admin_center.verification_notes AS admin_medical_center_verification_notes,
    mcu.medical_center_id AS center_user_medical_center_id,
    mcu.status AS center_user_status,
    mcd_active.medical_center_id AS active_doctor_center_medical_center_id,
    d.medical_center_id AS doctor_medical_center_id,
    r.medical_center_id AS receptionist_medical_center_id,
    LOWER(COALESCE(reception_center.verification_status, 'pending')) AS receptionist_medical_center_verification_status,
    reception_center.verification_notes AS receptionist_medical_center_verification_notes,
    linked_pharmacy.id AS pharmacy_id,
    linked_pharmacy.name AS pharmacy_name,
    LOWER(COALESCE(linked_pharmacy.verification_status, 'pending')) AS pharmacy_verification_status,
    linked_pharmacy.verification_notes AS pharmacy_verification_notes
  FROM users u
  LEFT JOIN doctors d ON d.user_id = u.id
  LEFT JOIN medical_center_admins mca ON mca.user_id = u.id
  LEFT JOIN medical_centers admin_center ON admin_center.id = mca.medical_center_id
  LEFT JOIN medical_center_users mcu
    ON mcu.user_id = u.id
   AND mcu.status = 'ACTIVE'
  LEFT JOIN LATERAL (
    SELECT medical_center_id
    FROM medical_center_doctors
    WHERE doctor_id = u.id
      AND status = 'ACTIVE'
    ORDER BY created_at ASC
    LIMIT 1
  ) mcd_active ON TRUE
  LEFT JOIN receptionists r ON r.user_id = u.id
  LEFT JOIN medical_centers reception_center ON reception_center.id = r.medical_center_id
  LEFT JOIN LATERAL (
    SELECT p.id, p.name, p.verification_status, p.verification_notes
    FROM pharmacist_pharmacies pp
    JOIN pharmacies p ON p.id = pp.pharmacy_id
    WHERE pp.user_id = u.id
    ORDER BY pp.created_at ASC
    LIMIT 1
  ) linked_pharmacy ON TRUE
`;

const getAuthUserPayload = async (user: LoginUserRow) => {
  const normalizedRole = String(user.role || "").toLowerCase();
  const medicalCenterMemberships = await pool.query<MedicalCenterMembershipRow>(
    `
      SELECT medical_center_id, role, status
      FROM medical_center_users
      WHERE user_id = $1
      ORDER BY joined_at ASC
    `,
    [user.id]
  );

  const centers: JwtCenterMembership[] = medicalCenterMemberships.rows
    .filter(
      (membership) =>
        typeof membership.medical_center_id === "string" && membership.status === "ACTIVE"
    )
    .map((membership) => ({
      id: membership.medical_center_id,
      role: String(membership.role || "").toLowerCase(),
    }));

  if (normalizedRole === "doctor") {
    const doctorCenterIds = await getDoctorCenterMembershipsForAuth(user.id);
    for (const medicalCenterId of doctorCenterIds) {
      if (!centers.some((center) => center.id === medicalCenterId && center.role === "doctor")) {
        centers.push({ id: medicalCenterId, role: "doctor" });
      }
    }
  }

  const medicalCenterId = resolveMedicalCenterId(user);
  const receptionistPermissions =
    normalizedRole === "receptionist"
      ? await getReceptionistPermissionsForAuth(user.id, medicalCenterId ?? centers[0]?.id ?? null)
      : undefined;
  const receptionistPermissionContract =
    normalizedRole === "receptionist"
      ? toReceptionistPermissionContract(receptionistPermissions)
      : undefined;
  const doctorVerificationStatus =
    normalizedRole === "doctor" ? normalizeVerificationStatus(user.doctor_verification_status) : null;
  const medicalCenterVerificationStatus =
    normalizedRole === "medical_center_admin"
      ? normalizeVerificationStatus(user.admin_medical_center_verification_status)
      : normalizedRole === "receptionist"
        ? normalizeVerificationStatus(user.receptionist_medical_center_verification_status)
        : null;
  const pharmacyVerificationStatus =
    normalizedRole === "pharmacist"
      ? normalizeVerificationStatus(user.pharmacy_verification_status)
      : null;
  const verificationStatus =
    normalizedRole === "doctor"
      ? doctorVerificationStatus
      : normalizedRole === "medical_center_admin"
        ? medicalCenterVerificationStatus
        : normalizedRole === "pharmacist"
          ? pharmacyVerificationStatus
          : normalizedRole === "receptionist"
            ? medicalCenterVerificationStatus
            : null;
  const verificationNotes =
    normalizedRole === "doctor"
      ? user.doctor_verification_notes
      : normalizedRole === "medical_center_admin"
        ? user.admin_medical_center_verification_notes
        : normalizedRole === "pharmacist"
          ? user.pharmacy_verification_notes
          : normalizedRole === "receptionist"
            ? user.receptionist_medical_center_verification_notes
            : null;

  return {
    medicalCenterMemberships,
    centers,
    medicalCenterId,
    receptionistPermissions: receptionistPermissionContract,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      medical_center_id: medicalCenterId ?? centers[0]?.id ?? null,
      centers,
      is_password_set: user.is_password_set,
      receptionist_permissions: receptionistPermissionContract,
      doctor_id: user.doctor_id,
      pharmacy_id: user.pharmacy_id,
      pharmacy_name: user.pharmacy_name,
      phone: user.doctor_phone,
      specialization: user.doctor_specialization,
      experience_years: user.doctor_experience_years,
      verification_status: verificationStatus,
      verificationStatus,
      approvalStatus: verificationStatus,
      status: verificationStatus,
      verification_notes: verificationNotes,
    },
  };
};

export const getAuthContextUserById = async (userId: number) => {
  const result = await pool.query<LoginUserRow>(
    `
      ${selectAuthContextSql}
      WHERE u.id = $1
      LIMIT 1
    `,
    [userId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("User not found", 404);
  }

  return getAuthUserPayload(result.rows[0]);
};

export const loginUserWithPassword = async (input: {
  email: string;
  password: string;
  expoPushToken?: string;
}) => {
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");

  if (!email || !password) {
    const error = new Error("Email and password are required");
    (error as any).statusCode = 400;
    throw error;
  }

  const result = await pool.query<LoginUserRow>(
    `
      ${selectAuthContextSql}
      WHERE LOWER(u.email) = $1
      LIMIT 1
    `,
    [email]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Invalid email or password", 401);
  }

  const user = result.rows[0];
  const storedPasswordHash = user.password_hash || user.password;
  const authUserPayload = await getAuthUserPayload(user);
  const hasCenterMembership = authUserPayload.medicalCenterMemberships.rows.length > 0;

  if (!user.is_password_set || !storedPasswordHash) {
    throw createStatusError("Password setup required before login", 403);
  }

  if (hasCenterMembership && authUserPayload.centers.length === 0) {
    throw createStatusError("User account is inactive", 403);
  }

  const passwordMatches = await comparePassword(password, storedPasswordHash);
  if (!passwordMatches) {
    throw createStatusError("Invalid email or password", 401);
  }

  if (input.expoPushToken && typeof input.expoPushToken === "string") {
    if (user.role === "patient") {
      await pool.query(
        `UPDATE patient_profiles SET expo_push_token = $1 WHERE user_id = $2`,
        [input.expoPushToken, user.id]
      );
    }

    if (user.role === "doctor") {
      await pool.query(`UPDATE doctors SET expo_push_token = $1 WHERE user_id = $2`, [
        input.expoPushToken,
        user.id,
      ]);
    }
  }

  const token = signAuthToken({
    id: user.id,
    email: user.email,
    role: user.role,
    medicalCenterId: authUserPayload.medicalCenterId ?? authUserPayload.centers[0]?.id ?? null,
    centers: authUserPayload.centers,
    receptionistPermissions: authUserPayload.receptionistPermissions,
  });

  return {
    token,
    user: authUserPayload.user,
  };
};

export const setPasswordFromToken = async (input: {
  token: string;
  password: string;
}) =>
  completePasswordSetupToken({
    token: input.token,
    password: input.password,
    invalidTokenMessage: "Invalid setup token",
    usedTokenMessage: "Setup token has already been used",
    expiredTokenMessage: "Setup token has expired",
    successMessage: "Password set successfully",
    auditAction: "password_set",
  });

export const resetPasswordFromToken = async (input: {
  token: string;
  password: string;
}) =>
  completePasswordSetupToken({
    token: input.token,
    password: input.password,
    invalidTokenMessage: "Invalid token",
    usedTokenMessage: "Token already used",
    expiredTokenMessage: "Token expired",
    successMessage: "Password reset successfully",
    auditAction: "password_reset",
  });

export const validatePasswordResetToken = async (input: { token: string }) => {
  const token = String(input.token || "").trim();

  if (!token) {
    throw createStatusError("Token missing", 400);
  }

  const client = await pool.connect();
  try {
    const matchedToken = await findMatchingPasswordToken(client, token);

    if (!matchedToken) {
      throw createStatusError("Invalid token", 400);
    }

    if (matchedToken.is_used) {
      throw createStatusError("Token already used", 400);
    }

    const expiresAt = new Date(matchedToken.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw createStatusError("Token expired", 400);
    }

    return { valid: true, expiresAt: expiresAt.toISOString() };
  } finally {
    client.release();
  }
};

export const createForgotPasswordReset = async (input: { email: string }) => {
  const email = normalizeEmail(input.email);

  if (!email) {
    throw createStatusError("Email is required", 400);
  }

  const userResult = await pool.query<PasswordResetUserRow>(
    `
      SELECT id, name, email
      FROM users
      WHERE LOWER(email) = $1
      LIMIT 1
    `,
    [email]
  );

  if (userResult.rows.length === 0) {
    return { message: "Reset link sent to your email" };
  }

  const user = userResult.rows[0];
  const client = await pool.connect();
  let emailPayload: { to: string; name: string; webLink: string } | null = null;

  try {
    await client.query("BEGIN");
    await client.query(`UPDATE password_setup_tokens SET is_used = TRUE WHERE user_id = $1`, [user.id]);

    const rawToken = generateToken();
    const lookupHash = sha256(rawToken);
    const hashedToken = await hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await client.query(
      `
        INSERT INTO password_setup_tokens (user_id, token, token_lookup_hash, expires_at, is_used)
        VALUES ($1, $2, $3, $4, FALSE)
      `,
      [user.id, hashedToken, lookupHash, expiresAt]
    );

    await client.query("COMMIT");

    emailPayload = {
      to: user.email,
      name: user.name,
      webLink: buildPasswordResetLink(rawToken),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (emailPayload) {
    try {
      await sendPasswordResetEmail(emailPayload);
    } catch (error) {
      console.log("Send forgot password email error:", error);
    }
  }

  return { message: "Reset link sent to your email" };
};
