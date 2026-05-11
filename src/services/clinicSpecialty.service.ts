import pool from "../config/db";

type AppError = Error & { statusCode?: number };

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
};

const normalizeName = (value: unknown) => String(value || "").trim();

export const listClinicSpecialties = async (medicalCenterId: string) => {
  const result = await pool.query<{
    id: string;
    name: string;
    clinic_id: string;
    created_at: string;
  }>(
    `
      SELECT id::text, name, clinic_id::text, created_at::text
      FROM clinic_specialties
      WHERE clinic_id = $1::uuid
      ORDER BY LOWER(name) ASC, created_at ASC
    `,
    [medicalCenterId]
  );

  return result.rows;
};

export const createClinicSpecialty = async (input: {
  medicalCenterId: string;
  name: string;
}) => {
  const name = normalizeName(input.name);
  if (!name) {
    throw createStatusError("Specialty name is required", 400);
  }

  const result = await pool.query<{
    id: string;
    name: string;
    clinic_id: string;
    created_at: string;
  }>(
    `
      INSERT INTO clinic_specialties (clinic_id, name)
      VALUES ($1::uuid, $2)
      RETURNING id::text, name, clinic_id::text, created_at::text
    `,
    [input.medicalCenterId, name]
  );

  return result.rows[0];
};

export const updateClinicSpecialty = async (input: {
  medicalCenterId: string;
  specialtyId: string;
  name: string;
}) => {
  const name = normalizeName(input.name);
  if (!name) {
    throw createStatusError("Specialty name is required", 400);
  }

  const result = await pool.query<{
    id: string;
    name: string;
    clinic_id: string;
    created_at: string;
  }>(
    `
      UPDATE clinic_specialties
      SET name = $1
      WHERE id = $2::uuid
        AND clinic_id = $3::uuid
      RETURNING id::text, name, clinic_id::text, created_at::text
    `,
    [name, input.specialtyId, input.medicalCenterId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Clinic specialty not found", 404);
  }

  return result.rows[0];
};

export const deleteClinicSpecialty = async (input: {
  medicalCenterId: string;
  specialtyId: string;
}) => {
  const result = await pool.query<{ id: string }>(
    `
      DELETE FROM clinic_specialties
      WHERE id = $1::uuid
        AND clinic_id = $2::uuid
      RETURNING id::text
    `,
    [input.specialtyId, input.medicalCenterId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Clinic specialty not found", 404);
  }

  return { message: "Clinic specialty deleted successfully" };
};
