import type { PoolClient } from "pg";
import pool from "../config/db";
import { env } from "../config/env";
import { createAuditLogWithClient } from "./audit.service";
import { sendDoctorInviteEmail } from "./email.service";
import { generateToken, sha256 } from "../utils/security";

type AppError = Error & { statusCode?: number };

type DoctorRelationshipStatus = "PENDING" | "ACTIVE" | "INACTIVE" | "REJECTED";
type DoctorInviteStatus = "PENDING" | "ACCEPTED" | "EXPIRED";
type DoctorJoinRequestStatus = "PENDING" | "APPROVED" | "REJECTED";

type DoctorAssignmentRow = {
  relationship_id: string;
  doctor_id: number | null;
  doctor_profile_id: number | null;
  name: string | null;
  email: string;
  profile_image: string | null;
  specialization: string | null;
  clinic_specialty_id: string | null;
  clinic_specialty: string | null;
  status: DoctorRelationshipStatus;
  joined_at: string;
  invite_id: string | null;
  invite_status: DoctorInviteStatus | null;
  is_pinned: boolean;
  is_hidden: boolean;
};

type DoctorJoinRequestRow = {
  id: string;
  doctor_id: number;
  medical_center_id: string;
  status: DoctorJoinRequestStatus;
  created_at: string;
  doctor_name: string;
  doctor_email: string;
  specialization: string | null;
};

type DoctorInviteRow = {
  id: string;
  medical_center_id: string;
  email: string;
  token: string;
  status: DoctorInviteStatus;
  expires_at: string | Date;
  created_at: string;
};

type DoctorUserRow = {
  id: number;
  email: string;
  role: string;
  name: string;
};

type ActiveDoctorCenterRow = {
  medical_center_id: string;
};

type DoctorClinicMembershipRow = {
  relationship_id: string;
  clinic_id: string;
  clinic_name: string;
  clinic_location: string | null;
  status: DoctorRelationshipStatus;
};

const DOCTOR_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const normalizeStatus = (value: unknown) => String(value || "").trim().toUpperCase();

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
};

const getWebBaseUrl = (webBaseUrl?: string) => {
  const value =
    webBaseUrl?.trim() ||
    env.appWebUrl?.trim() ||
    env.publicAppUrl?.trim() ||
    env.receptionistSetupUrl?.trim();

  return value ? value.replace(/\/$/, "") : null;
};

const buildDoctorInviteLink = (rawToken: string, webBaseUrl?: string) => {
  const baseUrl = getWebBaseUrl(webBaseUrl);
  if (!baseUrl) {
    return `/register?token=${rawToken}&role=doctor`;
  }

  return `${baseUrl}/register?token=${rawToken}&role=doctor`;
};

const requireDoctorUser = async (client: PoolClient, userId: number) => {
  const result = await client.query<DoctorUserRow>(
    `
      SELECT u.id, u.email, u.role, u.name
      FROM users u
      WHERE u.id = $1
      LIMIT 1
    `,
    [userId]
  );

  if (result.rows.length === 0 || String(result.rows[0].role).toLowerCase() !== "doctor") {
    throw createStatusError("Doctor account not found", 404);
  }

  return result.rows[0];
};

const requireMedicalCenter = async (client: PoolClient, medicalCenterId: string) => {
  const result = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM medical_centers WHERE id = $1 LIMIT 1`,
    [medicalCenterId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Medical center not found", 404);
  }

  return result.rows[0];
};

const expireInviteIfNeeded = async (client: PoolClient, invite: DoctorInviteRow) => {
  const expiresAt = new Date(invite.expires_at);
  if (invite.status === "PENDING" && expiresAt.getTime() <= Date.now()) {
    await client.query(
      `
        UPDATE doctor_invites
        SET status = 'EXPIRED'
        WHERE id = $1
      `,
      [invite.id]
    );

    return { ...invite, status: "EXPIRED" as const };
  }

  return invite;
};

const getDoctorAssignmentByRelationshipId = async (
  client: PoolClient,
  medicalCenterId: string,
  relationshipId: string
) => {
  const result = await client.query<{
    id: string;
    doctor_id: number;
    status: DoctorRelationshipStatus;
  }>(
    `
      SELECT id, doctor_id, status
      FROM medical_center_doctors
      WHERE id = $1
        AND medical_center_id = $2
      LIMIT 1
    `,
    [relationshipId, medicalCenterId]
  );

  return result.rows[0] ?? null;
};

const syncDoctorPrimaryMedicalCenter = async (client: PoolClient, doctorUserId: number) => {
  const doctorResult = await client.query<{ id: number; medical_center_id: string | null }>(
    `
      SELECT id, medical_center_id
      FROM doctors
      WHERE user_id = $1
      LIMIT 1
    `,
    [doctorUserId]
  );

  if (doctorResult.rows.length === 0) {
    return;
  }

  const activeCenters = await client.query<ActiveDoctorCenterRow>(
    `
      SELECT medical_center_id
      FROM medical_center_doctors
      WHERE doctor_id = $1
        AND status = 'ACTIVE'
      ORDER BY created_at ASC
    `,
    [doctorUserId]
  );

  const nextCenterId = activeCenters.rows[0]?.medical_center_id ?? null;

  await client.query(
    `
      UPDATE doctors
      SET medical_center_id = $1
      WHERE user_id = $2
    `,
    [nextCenterId, doctorUserId]
  );
};

const createDoctorInviteRecord = async (
  client: PoolClient,
  medicalCenterId: string,
  email: string
) => {
  const rawToken = generateToken();
  const hashedToken = sha256(rawToken);
  const expiresAt = new Date(Date.now() + DOCTOR_INVITE_TTL_MS);

  const inviteResult = await client.query<DoctorInviteRow>(
    `
      INSERT INTO doctor_invites (
        medical_center_id,
        email,
        token,
        status,
        expires_at
      )
      VALUES ($1, $2, $3, 'PENDING', $4)
      RETURNING id, medical_center_id, email, token, status, expires_at, created_at
    `,
    [medicalCenterId, email, hashedToken, expiresAt]
  );

  return {
    invite: inviteResult.rows[0],
    rawToken,
    expiresAt: expiresAt.toISOString(),
  };
};

const getDoctorAssociationMemberships = async (userId: number) => {
  const result = await pool.query<{ medical_center_id: string }>(
    `
      SELECT medical_center_id
      FROM medical_center_doctors
      WHERE doctor_id = $1
        AND status = 'ACTIVE'
      ORDER BY created_at ASC
    `,
    [userId]
  );

  return result.rows.map((row) => row.medical_center_id);
};

export const getDoctorCenterMembershipsForAuth = async (userId: number) => {
  return getDoctorAssociationMemberships(userId);
};

export const listDoctorClinics = async (doctorUserId: number) => {
  const result = await pool.query<DoctorClinicMembershipRow>(
    `
      SELECT
        mcd.id AS relationship_id,
        mc.id AS clinic_id,
        mc.name AS clinic_name,
        mc.address AS clinic_location,
        mcd.status
      FROM medical_center_doctors mcd
      JOIN medical_centers mc ON mc.id = mcd.medical_center_id
      WHERE mcd.doctor_id = $1
        AND mcd.status IN ('ACTIVE', 'PENDING')
      ORDER BY
        CASE
          WHEN mcd.status = 'ACTIVE' THEN 0
          ELSE 1
        END,
        mc.name ASC
    `,
    [doctorUserId]
  );

  const active = result.rows
    .filter((row) => row.status === "ACTIVE")
    .map((row) => ({
      id: row.relationship_id,
      medical_center_id: row.clinic_id,
      name: row.clinic_name,
      location: row.clinic_location ?? undefined,
    }));

  const pending = result.rows
    .filter((row) => row.status === "PENDING")
    .map((row) => ({
      id: row.relationship_id,
      medical_center_id: row.clinic_id,
      name: row.clinic_name,
      location: row.clinic_location ?? undefined,
    }));

  return { active, pending };
};

const getDoctorClinicRelationship = async (client: PoolClient, input: {
  doctorUserId: number;
  relationshipId: string;
}) => {
  const result = await client.query<{
    id: string;
    medical_center_id: string;
    status: DoctorRelationshipStatus;
  }>(
    `
      SELECT id, medical_center_id, status
      FROM medical_center_doctors
      WHERE id = $1
        AND doctor_id = $2
      LIMIT 1
    `,
    [input.relationshipId, input.doctorUserId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Clinic invitation not found", 404);
  }

  return result.rows[0];
};

export const acceptDoctorClinicInvite = async (input: {
  doctorUserId: number;
  relationshipId: string;
}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await requireDoctorUser(client, input.doctorUserId);
    const relationship = await getDoctorClinicRelationship(client, input);

    if (relationship.status === "ACTIVE") {
      throw createStatusError("Clinic invitation has already been accepted", 409);
    }

    if (relationship.status !== "PENDING") {
      throw createStatusError("Only pending clinic invitations can be accepted", 400);
    }

    await client.query(
      `
        UPDATE medical_center_doctors
        SET status = 'ACTIVE', updated_at = NOW()
        WHERE id = $1
      `,
      [relationship.id]
    );

    await syncDoctorPrimaryMedicalCenter(client, input.doctorUserId);

    await createAuditLogWithClient(client, {
      userId: input.doctorUserId,
      action: "doctor_clinic_invite_accepted",
    });

    await client.query("COMMIT");

    return { message: "Clinic invitation accepted successfully" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const rejectDoctorClinicInvite = async (input: {
  doctorUserId: number;
  relationshipId: string;
}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await requireDoctorUser(client, input.doctorUserId);
    const relationship = await getDoctorClinicRelationship(client, input);

    if (relationship.status === "ACTIVE") {
      throw createStatusError("Active clinics cannot be rejected", 400);
    }

    if (relationship.status !== "PENDING") {
      throw createStatusError("Only pending clinic invitations can be rejected", 400);
    }

    await client.query(
      `
        UPDATE medical_center_doctors
        SET status = 'REJECTED', updated_at = NOW()
        WHERE id = $1
      `,
      [relationship.id]
    );

    await syncDoctorPrimaryMedicalCenter(client, input.doctorUserId);

    await createAuditLogWithClient(client, {
      userId: input.doctorUserId,
      action: "doctor_clinic_invite_rejected",
    });

    await client.query("COMMIT");

    return { message: "Clinic invitation rejected successfully" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const inviteDoctorToMedicalCenter = async (input: {
  medicalCenterId: string;
  email: string;
  doctorId?: number;
  invitedByUserId: number;
  webBaseUrl?: string;
}) => {
  const client = await pool.connect();
  let emailPayload:
    | {
        to: string;
        clinicName: string;
        webLink: string;
      }
    | null = null;
  let response:
    | {
        message: string;
        invite: {
          id: string;
          email: string;
          status: DoctorInviteStatus;
          expires_at: string;
          relationship_status: DoctorRelationshipStatus | null;
        };
        emailSent: boolean;
        emailError: string | null;
      }
    | null = null;

  try {
    await client.query("BEGIN");

    const medicalCenter = await requireMedicalCenter(client, input.medicalCenterId);
    let email = normalizeEmail(input.email);

    if (input.doctorId) {
      const doctorLookupResult = await client.query<DoctorUserRow>(
        `
          SELECT u.id, u.email, u.role, u.name
          FROM doctors d
          JOIN users u ON u.id = d.user_id
          LEFT JOIN doctor_profile_visibility dpv ON dpv.doctor_id = d.id
          WHERE d.id = $1
            AND LOWER(COALESCE(u.role, '')) = 'doctor'
            AND COALESCE(dpv.visibility, 'PUBLIC') = 'PUBLIC'
          LIMIT 1
        `,
        [input.doctorId]
      );

      if (doctorLookupResult.rows.length === 0) {
        throw createStatusError("Doctor not found", 404);
      }

      email = normalizeEmail(doctorLookupResult.rows[0].email);
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw createStatusError("Valid doctor email is required", 400);
    }

    const existingPendingInviteResult = await client.query<DoctorInviteRow>(
      `
        SELECT id, medical_center_id, email, token, status, expires_at, created_at
        FROM doctor_invites
        WHERE medical_center_id = $1
          AND LOWER(email) = $2
          AND status = 'PENDING'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [input.medicalCenterId, email]
    );
    if (existingPendingInviteResult.rows.length > 0) {
      const pendingInvite = await expireInviteIfNeeded(client, existingPendingInviteResult.rows[0]);
      if (pendingInvite.status === "PENDING") {
        throw createStatusError("Doctor invite is already pending for this email", 409);
      }
    }

    const existingUserResult = await client.query<DoctorUserRow>(
      `
        SELECT id, email, role, name
        FROM users
        WHERE LOWER(email) = $1
        LIMIT 1
      `,
      [email]
    );

    let relationshipStatus: DoctorRelationshipStatus | null = null;

    if (existingUserResult.rows.length > 0) {
      const existingUser = existingUserResult.rows[0];

      if (String(existingUser.role).toLowerCase() !== "doctor") {
        throw createStatusError("Email already belongs to a non-doctor account", 409);
      }

      const existingRelationship = await client.query<{
        id: string;
        status: DoctorRelationshipStatus;
      }>(
        `
          SELECT id, status
          FROM medical_center_doctors
          WHERE medical_center_id = $1
            AND doctor_id = $2
          LIMIT 1
        `,
        [input.medicalCenterId, existingUser.id]
      );

      if (
        existingRelationship.rows.length > 0 &&
        ["ACTIVE", "PENDING", "INACTIVE"].includes(existingRelationship.rows[0].status)
      ) {
        throw createStatusError("Doctor already has an existing relationship with this center", 409);
      }

      if (existingRelationship.rows.length > 0) {
        await client.query(
          `
            UPDATE medical_center_doctors
            SET status = 'PENDING', updated_at = NOW()
            WHERE id = $1
          `,
          [existingRelationship.rows[0].id]
        );
      } else {
        await client.query(
          `
            INSERT INTO medical_center_doctors (
              medical_center_id,
              doctor_id,
              status
            )
            VALUES ($1, $2, 'PENDING')
          `,
          [input.medicalCenterId, existingUser.id]
        );
      }

      relationshipStatus = "PENDING";
    }

    const { invite, rawToken, expiresAt } = await createDoctorInviteRecord(
      client,
      input.medicalCenterId,
      email
    );
    const webLink = buildDoctorInviteLink(rawToken, input.webBaseUrl);

    emailPayload = {
      to: email,
      clinicName: medicalCenter.name,
      webLink,
    };

    await createAuditLogWithClient(client, {
      userId: input.invitedByUserId,
      action: "doctor_invited_to_center",
    });

    await client.query("COMMIT");

    response = {
      message: "Doctor invite sent successfully",
      invite: {
        id: invite.id,
        email,
        status: invite.status,
        expires_at: expiresAt,
        relationship_status: relationshipStatus,
      },
      emailSent: false,
      emailError: null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (emailPayload) {
    try {
      await sendDoctorInviteEmail(emailPayload);
      response!.emailSent = true;
    } catch (error) {
      response!.emailError =
        error instanceof Error ? error.message : "Failed to send doctor invite email";
    }
  }

  return response!;
};

export const resendDoctorInvite = async (input: {
  medicalCenterId: string;
  inviteId: string;
  requestedByUserId: number;
  webBaseUrl?: string;
}) => {
  const client = await pool.connect();
  let emailPayload:
    | {
        to: string;
        clinicName: string;
        webLink: string;
      }
    | null = null;
  let response:
    | {
        message: string;
        invite: {
          id: string;
          email: string;
          status: DoctorInviteStatus;
          expires_at: string;
        };
        emailSent: boolean;
        emailError: string | null;
      }
    | null = null;

  try {
    await client.query("BEGIN");

    const medicalCenter = await requireMedicalCenter(client, input.medicalCenterId);
    const inviteResult = await client.query<DoctorInviteRow>(
      `
        SELECT id, medical_center_id, email, token, status, expires_at, created_at
        FROM doctor_invites
        WHERE id = $1
          AND medical_center_id = $2
        LIMIT 1
      `,
      [input.inviteId, input.medicalCenterId]
    );

    if (inviteResult.rows.length === 0) {
      throw createStatusError("Doctor invite not found", 404);
    }

    const invite = await expireInviteIfNeeded(client, inviteResult.rows[0]);

    if (invite.status === "ACCEPTED") {
      throw createStatusError("Accepted doctor invites cannot be resent", 400);
    }

    await client.query(
      `
        UPDATE doctor_invites
        SET status = 'EXPIRED'
        WHERE id = $1
      `,
      [invite.id]
    );

    const { invite: newInvite, rawToken, expiresAt } = await createDoctorInviteRecord(
      client,
      input.medicalCenterId,
      invite.email
    );
    const webLink = buildDoctorInviteLink(rawToken, input.webBaseUrl);

    emailPayload = {
      to: invite.email,
      clinicName: medicalCenter.name,
      webLink,
    };

    await createAuditLogWithClient(client, {
      userId: input.requestedByUserId,
      action: "doctor_invite_resent",
    });

    await client.query("COMMIT");

    response = {
      message: "Doctor invite resent successfully",
      invite: {
        id: newInvite.id,
        email: newInvite.email,
        status: newInvite.status,
        expires_at: expiresAt,
      },
      emailSent: false,
      emailError: null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (emailPayload) {
    try {
      await sendDoctorInviteEmail(emailPayload);
      response!.emailSent = true;
    } catch (error) {
      response!.emailError =
        error instanceof Error ? error.message : "Failed to send doctor invite email";
    }
  }

  return response!;
};

export const acceptDoctorInvite = async (input: {
  doctorUserId: number;
  token: string;
}) => {
  const token = String(input.token || "").trim();
  if (!token) {
    throw createStatusError("Invite token is required", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const doctorUser = await requireDoctorUser(client, input.doctorUserId);
    const hashedToken = sha256(token);
    const inviteResult = await client.query<DoctorInviteRow>(
      `
        SELECT id, medical_center_id, email, token, status, expires_at, created_at
        FROM doctor_invites
        WHERE token = $1
        LIMIT 1
      `,
      [hashedToken]
    );

    if (inviteResult.rows.length === 0) {
      throw createStatusError("Invalid invite token", 400);
    }

    const invite = await expireInviteIfNeeded(client, inviteResult.rows[0]);
    if (invite.status !== "PENDING") {
      throw createStatusError("Invite is no longer active", 400);
    }

    const expiresAt = new Date(invite.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw createStatusError("Invite token has expired", 400);
    }

    if (normalizeEmail(doctorUser.email) !== normalizeEmail(invite.email)) {
      throw createStatusError("Invite email does not match the current doctor account", 403);
    }

    const relationshipResult = await client.query<{
      id: string;
      status: DoctorRelationshipStatus;
    }>(
      `
        SELECT id, status
        FROM medical_center_doctors
        WHERE medical_center_id = $1
          AND doctor_id = $2
        LIMIT 1
      `,
      [invite.medical_center_id, input.doctorUserId]
    );

    if (relationshipResult.rows.length > 0) {
      if (relationshipResult.rows[0].status === "ACTIVE") {
        throw createStatusError("Doctor is already assigned to this medical center", 409);
      }

      await client.query(
        `
          UPDATE medical_center_doctors
          SET status = 'ACTIVE', updated_at = NOW()
          WHERE id = $1
        `,
        [relationshipResult.rows[0].id]
      );
    } else {
      await client.query(
        `
          INSERT INTO medical_center_doctors (
            medical_center_id,
            doctor_id,
            status
          )
          VALUES ($1, $2, 'ACTIVE')
        `,
        [invite.medical_center_id, input.doctorUserId]
      );
    }

    await client.query(
      `
        UPDATE doctor_invites
        SET status = 'ACCEPTED'
        WHERE id = $1
      `,
      [invite.id]
    );

    await client.query(
      `
        UPDATE doctor_join_requests
        SET status = 'APPROVED', updated_at = NOW()
        WHERE doctor_id = $1
          AND medical_center_id = $2
          AND status = 'PENDING'
      `,
      [input.doctorUserId, invite.medical_center_id]
    );

    await syncDoctorPrimaryMedicalCenter(client, input.doctorUserId);

    await createAuditLogWithClient(client, {
      userId: input.doctorUserId,
      action: "doctor_invite_accepted",
    });

    await client.query("COMMIT");

    return {
      message: "Doctor invite accepted successfully",
      medical_center_id: invite.medical_center_id,
      status: "ACTIVE" as const,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const createDoctorJoinRequest = async (input: {
  doctorUserId: number;
  medicalCenterId: string;
}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await requireMedicalCenter(client, input.medicalCenterId);
    await requireDoctorUser(client, input.doctorUserId);

    const existingRelationship = await client.query<{ status: DoctorRelationshipStatus }>(
      `
        SELECT status
        FROM medical_center_doctors
        WHERE medical_center_id = $1
          AND doctor_id = $2
        LIMIT 1
      `,
      [input.medicalCenterId, input.doctorUserId]
    );

    if (
      existingRelationship.rows.length > 0 &&
      ["ACTIVE", "PENDING", "INACTIVE"].includes(existingRelationship.rows[0].status)
    ) {
      throw createStatusError("Doctor already has an existing relationship with this center", 409);
    }

    const result = await client.query<{
      id: string;
      status: DoctorJoinRequestStatus;
      created_at: string;
    }>(
      `
        INSERT INTO doctor_join_requests (
          doctor_id,
          medical_center_id,
          status
        )
        VALUES ($1, $2, 'PENDING')
        ON CONFLICT (doctor_id, medical_center_id)
        DO UPDATE SET
          status = 'PENDING',
          updated_at = NOW()
        RETURNING id, status, created_at
      `,
      [input.doctorUserId, input.medicalCenterId]
    );

    await createAuditLogWithClient(client, {
      userId: input.doctorUserId,
      action: "doctor_join_request_created",
    });

    await client.query("COMMIT");

    return {
      message: "Join request submitted successfully",
      request: result.rows[0],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const reviewDoctorJoinRequest = async (input: {
  requestId: string;
  medicalCenterId: string;
  action: "APPROVE" | "REJECT";
  reviewedByUserId: number;
}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const requestResult = await client.query<DoctorJoinRequestRow>(
      `
        SELECT
          djr.id,
          djr.doctor_id,
          djr.medical_center_id,
          djr.status,
          djr.created_at,
          u.name AS doctor_name,
          u.email AS doctor_email,
          d.specialization
        FROM doctor_join_requests djr
        JOIN users u ON u.id = djr.doctor_id
        LEFT JOIN doctors d ON d.user_id = djr.doctor_id
        WHERE djr.id = $1
          AND djr.medical_center_id = $2
        LIMIT 1
      `,
      [input.requestId, input.medicalCenterId]
    );

    if (requestResult.rows.length === 0) {
      throw createStatusError("Doctor join request not found", 404);
    }

    const joinRequest = requestResult.rows[0];
    if (joinRequest.status !== "PENDING") {
      throw createStatusError("Doctor join request has already been reviewed", 400);
    }

    if (joinRequest.doctor_id === input.reviewedByUserId) {
      throw createStatusError("Doctors cannot approve their own join requests", 403);
    }

    if (input.action === "APPROVE") {
      const relationshipResult = await client.query<{ id: string; status: DoctorRelationshipStatus }>(
        `
          SELECT id, status
          FROM medical_center_doctors
          WHERE medical_center_id = $1
            AND doctor_id = $2
          LIMIT 1
        `,
        [input.medicalCenterId, joinRequest.doctor_id]
      );

      if (relationshipResult.rows.length > 0) {
        if (relationshipResult.rows[0].status === "ACTIVE") {
          throw createStatusError("Doctor is already active in this medical center", 409);
        }

        await client.query(
          `
            UPDATE medical_center_doctors
            SET status = 'ACTIVE', updated_at = NOW()
            WHERE id = $1
          `,
          [relationshipResult.rows[0].id]
        );
      } else {
        await client.query(
          `
            INSERT INTO medical_center_doctors (
              medical_center_id,
              doctor_id,
              status
            )
            VALUES ($1, $2, 'ACTIVE')
          `,
          [input.medicalCenterId, joinRequest.doctor_id]
        );
      }

      await client.query(
        `
          UPDATE doctor_join_requests
          SET status = 'APPROVED', updated_at = NOW()
          WHERE id = $1
        `,
        [joinRequest.id]
      );

      await syncDoctorPrimaryMedicalCenter(client, joinRequest.doctor_id);
    } else {
      await client.query(
        `
          UPDATE doctor_join_requests
          SET status = 'REJECTED', updated_at = NOW()
          WHERE id = $1
        `,
        [joinRequest.id]
      );
    }

    await createAuditLogWithClient(client, {
      userId: input.reviewedByUserId,
      action: `doctor_join_request_${input.action.toLowerCase()}`,
    });

    await client.query("COMMIT");

    return {
      message:
        input.action === "APPROVE"
          ? "Doctor join request approved successfully"
          : "Doctor join request rejected successfully",
      request: {
        id: joinRequest.id,
        doctor_id: joinRequest.doctor_id,
        status: input.action === "APPROVE" ? "APPROVED" : "REJECTED",
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const listDoctorJoinRequestsForCenter = async (medicalCenterId: string) => {
  const result = await pool.query<DoctorJoinRequestRow>(
    `
      SELECT
        djr.id,
        djr.doctor_id,
        djr.medical_center_id,
        djr.status,
        djr.created_at,
        u.name AS doctor_name,
        u.email AS doctor_email,
        d.specialization
      FROM doctor_join_requests djr
      JOIN users u ON u.id = djr.doctor_id
      LEFT JOIN doctors d ON d.user_id = djr.doctor_id
      WHERE djr.medical_center_id = $1
        AND djr.status = 'PENDING'
      ORDER BY djr.created_at DESC
    `,
    [medicalCenterId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    doctor_id: row.doctor_id,
    name: row.doctor_name,
    email: row.doctor_email,
    specialization: row.specialization,
    status: row.status,
    created_at: row.created_at,
  }));
};

export const listMedicalCenterDoctorsWithInvites = async (medicalCenterId: string) => {
  await pool.query(
    `
      UPDATE doctor_invites
      SET status = 'EXPIRED'
      WHERE medical_center_id = $1
        AND status = 'PENDING'
        AND expires_at <= NOW()
    `,
    [medicalCenterId]
  );

  const [relationshipsResult, pendingInvitesResult] = await Promise.all([
    pool.query<DoctorAssignmentRow>(
      `
        SELECT
          mcd.id AS relationship_id,
          mcd.doctor_id,
          d.id AS doctor_profile_id,
          u.name,
          u.email,
          u.profile_image,
          d.specialization,
          mcd.clinic_specialty_id::text AS clinic_specialty_id,
          cs.name AS clinic_specialty,
          mcd.status,
          mcd.created_at AS joined_at,
          COALESCE(mcd.is_pinned, FALSE) AS is_pinned,
          COALESCE(mcd.is_hidden, FALSE) AS is_hidden,
          (
            SELECT di.id
            FROM doctor_invites di
            WHERE di.medical_center_id = mcd.medical_center_id
              AND LOWER(di.email) = LOWER(u.email)
            ORDER BY di.created_at DESC
            LIMIT 1
          ) AS invite_id,
          (
            SELECT di.status
            FROM doctor_invites di
            WHERE di.medical_center_id = mcd.medical_center_id
              AND LOWER(di.email) = LOWER(u.email)
            ORDER BY di.created_at DESC
            LIMIT 1
          ) AS invite_status
        FROM medical_center_doctors mcd
        JOIN users u ON u.id = mcd.doctor_id
        LEFT JOIN doctors d ON d.user_id = mcd.doctor_id
        LEFT JOIN clinic_specialties cs ON cs.id = mcd.clinic_specialty_id
        WHERE mcd.medical_center_id = $1
          AND mcd.status != 'REJECTED'
        ORDER BY mcd.created_at DESC
      `,
      [medicalCenterId]
    ),
    pool.query<{
      id: string;
      email: string;
      status: DoctorInviteStatus;
      created_at: string;
    }>(
      `
        SELECT di.id, di.email, di.status, di.created_at
        FROM doctor_invites di
        WHERE di.medical_center_id = $1
          AND di.status = 'PENDING'
          AND NOT EXISTS (
            SELECT 1
            FROM users u
            WHERE LOWER(u.email) = LOWER(di.email)
          )
        ORDER BY di.created_at DESC
      `,
      [medicalCenterId]
    ),
  ]);

  const relationshipRows = relationshipsResult.rows.map((row) => ({
    id: row.relationship_id,
    doctor_id: row.doctor_id,
    doctor_profile_id: row.doctor_profile_id,
    invite_id: row.invite_id,
    name: row.name,
    email: row.email,
    profile_image: row.profile_image,
    specialization: row.specialization,
    clinic_specialty_id: row.clinic_specialty_id,
    clinic_specialty: row.clinic_specialty,
    status: row.status,
    joined_at: row.joined_at,
    is_pinned: row.is_pinned,
    is_hidden: row.is_hidden,
  }));

  const inviteRows = pendingInvitesResult.rows.map((row) => ({
    id: row.id,
    doctor_id: null,
    doctor_profile_id: null,
    invite_id: row.id,
    name: null,
    email: row.email,
    profile_image: null,
    specialization: null,
    clinic_specialty_id: null,
    clinic_specialty: null,
    status: "PENDING" as const,
    joined_at: row.created_at,
    is_pinned: false,
    is_hidden: false,
  }));

  return [...relationshipRows, ...inviteRows];
};

export const updateDoctorClinicSpecialty = async (input: {
  medicalCenterId: string;
  relationshipId: string;
  clinicSpecialtyId: string | null;
}) => {
  const relationship = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM medical_center_doctors
      WHERE id = $1
        AND medical_center_id = $2
      LIMIT 1
    `,
    [input.relationshipId, input.medicalCenterId]
  );

  if (relationship.rows.length === 0) {
    throw createStatusError("Doctor relationship not found", 404);
  }

  if (input.clinicSpecialtyId) {
    const specialty = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM clinic_specialties
        WHERE id = $1::uuid
          AND clinic_id = $2::uuid
        LIMIT 1
      `,
      [input.clinicSpecialtyId, input.medicalCenterId]
    );

    if (specialty.rows.length === 0) {
      throw createStatusError("Clinic specialty not found", 404);
    }
  }

  const result = await pool.query(
    `
      UPDATE medical_center_doctors
      SET clinic_specialty_id = $1::uuid,
          updated_at = NOW()
      WHERE id = $2
        AND medical_center_id = $3::uuid
      RETURNING id
    `,
    [input.clinicSpecialtyId, input.relationshipId, input.medicalCenterId]
  );

  return {
    message: "Doctor specialty updated successfully",
    relationshipId: result.rows[0]?.id ?? input.relationshipId,
    clinic_specialty_id: input.clinicSpecialtyId,
  };
};

export const updateDoctorRelationshipDisplayFlags = async (input: {
  medicalCenterId: string;
  relationshipId: string;
  pinned?: boolean;
  hidden?: boolean;
}) => {
  const relationship = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM medical_center_doctors
      WHERE id = $1
        AND medical_center_id = $2::uuid
      LIMIT 1
    `,
    [input.relationshipId, input.medicalCenterId]
  );

  if (relationship.rows.length === 0) {
    throw createStatusError("Doctor relationship not found", 404);
  }

  const result = await pool.query<{
    id: string;
    is_pinned: boolean;
    is_hidden: boolean;
  }>(
    `
      UPDATE medical_center_doctors
      SET
        is_pinned = COALESCE($1::boolean, is_pinned),
        is_hidden = COALESCE($2::boolean, is_hidden),
        updated_at = NOW()
      WHERE id = $3
        AND medical_center_id = $4::uuid
      RETURNING id, COALESCE(is_pinned, FALSE) AS is_pinned, COALESCE(is_hidden, FALSE) AS is_hidden
    `,
    [
      typeof input.pinned === "boolean" ? input.pinned : null,
      typeof input.hidden === "boolean" ? input.hidden : null,
      input.relationshipId,
      input.medicalCenterId,
    ]
  );

  return {
    message: "Doctor display settings updated successfully",
    relationshipId: result.rows[0].id,
    is_pinned: result.rows[0].is_pinned,
    is_hidden: result.rows[0].is_hidden,
  };
};

export const updateDoctorRelationshipStatus = async (input: {
  medicalCenterId: string;
  relationshipId: string;
  status: "ACTIVE" | "INACTIVE";
  updatedByUserId: number;
}) => {
  const status = normalizeStatus(input.status);
  if (!["ACTIVE", "INACTIVE"].includes(status)) {
    throw createStatusError("status must be ACTIVE or INACTIVE", 400);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const relationship = await getDoctorAssignmentByRelationshipId(
      client,
      input.medicalCenterId,
      input.relationshipId
    );

    if (!relationship) {
      throw createStatusError("Doctor relationship not found", 404);
    }

    if (relationship.status === "PENDING") {
      throw createStatusError("Pending doctor relationships must be accepted by the doctor", 400);
    }

    await client.query(
      `
        UPDATE medical_center_doctors
        SET status = $1, updated_at = NOW()
        WHERE id = $2
      `,
      [status, relationship.id]
    );

    await syncDoctorPrimaryMedicalCenter(client, relationship.doctor_id);

    await createAuditLogWithClient(client, {
      userId: input.updatedByUserId,
      action: `doctor_relationship_${status.toLowerCase()}`,
    });

    await client.query("COMMIT");

    return {
      message:
        status === "ACTIVE"
          ? "Doctor relationship enabled successfully"
          : "Doctor relationship disabled successfully",
      status,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const removeDoctorFromMedicalCenter = async (input: {
  medicalCenterId: string;
  relationshipId: string;
  removedByUserId: number;
}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const relationship = await getDoctorAssignmentByRelationshipId(
      client,
      input.medicalCenterId,
      input.relationshipId
    );

    if (!relationship) {
      throw createStatusError("Doctor relationship not found", 404);
    }

    await client.query(
      `
        DELETE FROM medical_center_doctors
        WHERE id = $1
      `,
      [relationship.id]
    );

    await syncDoctorPrimaryMedicalCenter(client, relationship.doctor_id);

    await createAuditLogWithClient(client, {
      userId: input.removedByUserId,
      action: "doctor_relationship_removed",
    });

    await client.query("COMMIT");

    return {
      message: "Doctor removed from medical center successfully",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
