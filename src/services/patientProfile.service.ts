import pool from "../config/db";

type PatientProfileUpdateInput = {
  name?: string;
  email?: string;
  phone?: string;
  dob?: string;
  gender?: string;
  blood_group?: string;
  allergies?: string;
  conditions?: string;
  emergency_name?: string;
  emergency_phone?: string;
  nic?: string;
  address?: string;
  city?: string;
};

type HttpError = Error & { statusCode?: number };

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

const getPatientProfileQuery = `
  SELECT 
    u.id,
    u.name,
    u.email,
    u.role,
    p.phone,
    p.dob,
    p.gender,
    p.blood_group,
    p.allergies,
    p.conditions,
    p.emergency_name,
    p.emergency_phone,
    p.nic,
    p.address,
    p.city
  FROM users u
  LEFT JOIN patient_profiles p ON p.user_id = u.id
  WHERE u.id = $1
`;

export const getPatientProfile = async (userId: number) => {
  const result = await pool.query(getPatientProfileQuery, [userId]);
  const profile = result.rows[0];

  if (!profile) {
    throw createStatusError("Patient profile not found", 404);
  }

  return profile;
};

export const updatePatientProfile = async (
  userId: number,
  input: PatientProfileUpdateInput
) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS patient_profiles (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        phone TEXT,
        dob DATE,
        gender TEXT,
        blood_group TEXT,
        allergies TEXT,
        conditions TEXT,
        emergency_name TEXT,
        emergency_phone TEXT,
        nic TEXT,
        address TEXT,
        city TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    if (input.name || input.email) {
      await client.query(
        `UPDATE users SET
          name = COALESCE($1, name),
          email = COALESCE($2, email)
        WHERE id = $3`,
        [input.name, input.email, userId]
      );
    }

    await client.query(
      `
      INSERT INTO patient_profiles (
        user_id, phone, dob, gender, blood_group, allergies, conditions,
        emergency_name, emergency_phone, nic, address, city, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        phone = COALESCE(EXCLUDED.phone, patient_profiles.phone),
        dob = COALESCE(EXCLUDED.dob, patient_profiles.dob),
        gender = COALESCE(EXCLUDED.gender, patient_profiles.gender),
        blood_group = COALESCE(EXCLUDED.blood_group, patient_profiles.blood_group),
        allergies = COALESCE(EXCLUDED.allergies, patient_profiles.allergies),
        conditions = COALESCE(EXCLUDED.conditions, patient_profiles.conditions),
        emergency_name = COALESCE(EXCLUDED.emergency_name, patient_profiles.emergency_name),
        emergency_phone = COALESCE(EXCLUDED.emergency_phone, patient_profiles.emergency_phone),
        nic = COALESCE(EXCLUDED.nic, patient_profiles.nic),
        address = COALESCE(EXCLUDED.address, patient_profiles.address),
        city = COALESCE(EXCLUDED.city, patient_profiles.city),
        updated_at = NOW()
      `,
      [
        userId,
        input.phone ?? null,
        input.dob ?? null,
        input.gender ?? null,
        input.blood_group ?? null,
        input.allergies ?? null,
        input.conditions ?? null,
        input.emergency_name ?? null,
        input.emergency_phone ?? null,
        input.nic ?? null,
        input.address ?? null,
        input.city ?? null,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getPatientProfile(userId);
};
