import bcrypt from "bcryptjs";
import pool from "../config/db";
import { io } from "../server";

const emitCenterEvent = (
  medicalCenterId: string,
  event: string,
  payload?: Record<string, unknown>
) => {
  io.to(`center_${medicalCenterId}`).emit(event, {
    medicalCenterId,
    ...(payload || {}),
  });
};

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();

type HttpError = Error & { statusCode?: number };

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

export const getMedicalCenterDashboard = async (medicalCenterId: string) => {
  const [
    centerResult,
    doctorCountResult,
    receptionistCountResult,
    queueCountResult,
    appointmentCountResult,
  ] = await Promise.all([
    pool.query(`SELECT id, name, address, phone, email, status FROM medical_centers WHERE id = $1`, [
      medicalCenterId,
    ]),
    pool.query(
      `
        SELECT COUNT(*)::int AS count
        FROM medical_center_doctors
        WHERE medical_center_id = $1
          AND status = 'ACTIVE'
      `,
      [medicalCenterId]
    ),
    pool.query(`SELECT COUNT(*)::int AS count FROM receptionists WHERE medical_center_id = $1`, [
      medicalCenterId,
    ]),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM queues WHERE medical_center_id = $1 AND status IN ('LIVE', 'PAUSED')`,
      [medicalCenterId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM bookings WHERE medical_center_id = $1 AND date = CURRENT_DATE`,
      [medicalCenterId]
    ),
  ]);

  return {
    center: centerResult.rows[0] ?? null,
    stats: {
      doctors: doctorCountResult.rows[0]?.count ?? 0,
      receptionists: receptionistCountResult.rows[0]?.count ?? 0,
      liveQueues: queueCountResult.rows[0]?.count ?? 0,
      todayAppointments: appointmentCountResult.rows[0]?.count ?? 0,
    },
  };
};

export const listMedicalCenterDoctors = async (medicalCenterId: string) => {
  const result = await pool.query(
    `
      SELECT d.id, d.user_id, d.phone, d.specialization, d.license_number, d.experience_years,
             d.medical_center_id, u.name, u.email, u.role
      FROM doctors d
      JOIN users u ON u.id = d.user_id
      WHERE d.medical_center_id = $1
      ORDER BY u.name ASC
    `,
    [medicalCenterId]
  );

  return result.rows;
};

type CreateDoctorInput = {
  medicalCenterId: string;
  name: string;
  email: string;
  password: string;
  phone?: string | null;
  specialization?: string | null;
  licenseNumber?: string | null;
  experienceYears?: number | null;
};

export const createMedicalCenterDoctor = async (input: CreateDoctorInput) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(`SELECT 1 FROM users WHERE email = $1`, [
      normalizeEmail(input.email),
    ]);
    if (existing.rows.length > 0) {
      throw createStatusError("Email already registered", 400);
    }

    const hashedPassword = await bcrypt.hash(input.password, 10);
    const userResult = await client.query(
      `
        INSERT INTO users (name, email, password, role)
        VALUES ($1, $2, $3, 'doctor')
        RETURNING id, name, email, role
      `,
      [input.name, normalizeEmail(input.email), hashedPassword]
    );

    const doctorResult = await client.query(
      `
        INSERT INTO doctors (user_id, phone, specialization, license_number, experience_years, medical_center_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, user_id, phone, specialization, license_number, experience_years, medical_center_id
      `,
      [
        userResult.rows[0].id,
        input.phone || null,
        input.specialization || null,
        input.licenseNumber || null,
        input.experienceYears ?? null,
        input.medicalCenterId,
      ]
    );

    await client.query("COMMIT");

    console.log("STATUS CHANGE:", doctorResult.rows[0].id, "UNASSIGNED", "CENTER_ASSIGNED");
    emitCenterEvent(input.medicalCenterId, "doctor:status", {
      type: "created",
      doctorId: doctorResult.rows[0].id,
    });

    return {
      ...userResult.rows[0],
      ...doctorResult.rows[0],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

type UpdateDoctorInput = {
  medicalCenterId: string;
  doctorId: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  specialization?: string | null;
  licenseNumber?: string | null;
  experienceYears?: number | null;
};

export const updateMedicalCenterDoctor = async (input: UpdateDoctorInput) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const scopedDoctor = await client.query(
      `
        SELECT d.id, d.user_id
        FROM doctors d
        WHERE d.id = $1 AND d.medical_center_id = $2
      `,
      [input.doctorId, input.medicalCenterId]
    );

    if (scopedDoctor.rows.length === 0) {
      throw createStatusError("Doctor not found", 404);
    }

    await client.query(
      `
        UPDATE users
        SET name = COALESCE($1, name),
            email = COALESCE($2, email),
            updated_at = NOW()
        WHERE id = $3
      `,
      [
        input.name || null,
        input.email ? normalizeEmail(input.email) : null,
        scopedDoctor.rows[0].user_id,
      ]
    );

    const updatedDoctor = await client.query(
      `
        UPDATE doctors
        SET phone = COALESCE($1, phone),
            specialization = COALESCE($2, specialization),
            license_number = COALESCE($3, license_number),
            experience_years = COALESCE($4, experience_years),
            updated_at = NOW()
        WHERE id = $5
        RETURNING *
      `,
      [
        input.phone || null,
        input.specialization || null,
        input.licenseNumber || null,
        input.experienceYears ?? null,
        input.doctorId,
      ]
    );

    await client.query("COMMIT");
    emitCenterEvent(input.medicalCenterId, "doctor:status", {
      type: "updated",
      doctorId: input.doctorId,
    });

    return updatedDoctor.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const deleteMedicalCenterDoctor = async (
  medicalCenterId: string,
  doctorId: number
) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const scopedDoctor = await client.query(
      `SELECT id, user_id FROM doctors WHERE id = $1 AND medical_center_id = $2`,
      [doctorId, medicalCenterId]
    );

    if (scopedDoctor.rows.length === 0) {
      throw createStatusError("Doctor not found", 404);
    }

    await client.query(`DELETE FROM users WHERE id = $1`, [scopedDoctor.rows[0].user_id]);
    await client.query("COMMIT");

    emitCenterEvent(medicalCenterId, "doctor:status", { type: "deleted", doctorId });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const listMedicalCenterQueues = async (medicalCenterId: string) => {
  const result = await pool.query(
    `
      SELECT *
      FROM queues
      WHERE medical_center_id = $1
      ORDER BY id DESC
    `,
    [medicalCenterId]
  );

  return result.rows;
};

export const listMedicalCenterAppointments = async (medicalCenterId: string) => {
  const result = await pool.query(
    `
      SELECT
        b.*,
        u.name AS patient_name,
        du.name AS doctor_name
      FROM bookings b
      LEFT JOIN users u ON u.id = b.patient_id
      LEFT JOIN doctors d ON d.id = b.doctor_id
      LEFT JOIN users du ON du.id = d.user_id
      WHERE b.medical_center_id = $1
      ORDER BY b.date DESC, b.time DESC
    `,
    [medicalCenterId]
  );

  return result.rows;
};
