import pool from "../config/db";

type HttpError = Error & { statusCode?: number };

type DoctorSelfProfileUpdateInput = {
  name?: string;
  phone?: string;
  specialization?: string;
  experience_years?: string | number;
  bio?: string;
  qualifications?: string;
  consultation_fee?: string | number;
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

const DOCTOR_SELF_PROFILE_QUERY = `
  SELECT
    u.id,
    u.name,
    u.email,
    u.role,
    u.profile_image,
    d.phone,
    d.specialization,
    d.experience_years,
    d.bio,
    d.qualifications,
    d.consultation_fee
  FROM users u
  JOIN doctors d ON d.user_id = u.id
  WHERE u.id = $1
    AND LOWER(COALESCE(u.role, '')) = 'doctor'
  LIMIT 1
`;

const normalizeOptionalString = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeOptionalInteger = (value: unknown) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createStatusError("Experience must be a valid non-negative number", 400);
  }

  return Math.trunc(parsed);
};

const normalizeOptionalFee = (value: unknown) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw createStatusError("Consultation fee must be a valid non-negative amount", 400);
    }
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw createStatusError("Consultation fee must be a valid non-negative amount", 400);
    }
    return parsed;
  }

  throw createStatusError("Consultation fee must be a valid amount", 400);
};

export const getDoctorSelfProfile = async (userId: number) => {
  const result = await pool.query(DOCTOR_SELF_PROFILE_QUERY, [userId]);
  const profile = result.rows[0];

  if (!profile) {
    throw createStatusError("Doctor profile not found", 404);
  }

  return profile;
};

export const updateDoctorSelfProfile = async (
  userId: number,
  input: DoctorSelfProfileUpdateInput
) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingResult = await client.query<{ id: number }>(
      `
      SELECT d.id
      FROM users u
      JOIN doctors d ON d.user_id = u.id
      WHERE u.id = $1
        AND LOWER(COALESCE(u.role, '')) = 'doctor'
      LIMIT 1
      `,
      [userId]
    );

    if (existingResult.rows.length === 0) {
      throw createStatusError("Doctor profile not found", 404);
    }

    const name = normalizeOptionalString(input.name);
    const phone = normalizeOptionalString(input.phone);
    const specialization = normalizeOptionalString(input.specialization);
    const bio = normalizeOptionalString(input.bio);
    const qualifications = normalizeOptionalString(input.qualifications);
    const experienceYears = normalizeOptionalInteger(input.experience_years);
    const consultationFee = normalizeOptionalFee(input.consultation_fee);

    await client.query(
      `
      UPDATE users
      SET name = COALESCE($1, name)
      WHERE id = $2
      `,
      [name, userId]
    );

    await client.query(
      `
      UPDATE doctors
      SET phone = COALESCE($1, phone),
          specialization = COALESCE($2, specialization),
          experience_years = COALESCE($3, experience_years),
          bio = COALESCE($4, bio),
          qualifications = COALESCE($5, qualifications),
          consultation_fee = COALESCE($6, consultation_fee),
          updated_at = NOW()
      WHERE user_id = $7
      `,
      [phone, specialization, experienceYears, bio, qualifications, consultationFee, userId]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getDoctorSelfProfile(userId);
};
