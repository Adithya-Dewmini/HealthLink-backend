import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import db from "../config/db";
import { signAuthToken } from "../utils/security";
import type { LoginRequestBody, RegisterRequestBody } from "../types/auth";

type HttpError = Error & { message: string };
type DbError = Error & { code?: string; detail?: string; constraint?: string };
type TokenUser = {
  id: number;
  email: string;
  role: string;
  medical_center_id: string | null;
};

// Helper to generate JWT
const generateToken = (user: TokenUser) => {
  const medicalCenterId = user.medical_center_id ?? null;

  return signAuthToken({
    id: user.id,
    email: user.email,
    role: user.role,
    medicalCenterId,
    centers: medicalCenterId ? [{ id: medicalCenterId, role: String(user.role || "").toLowerCase() }] : [],
  });
};

const normalizeRole = (role: unknown) => String(role || "").trim().toLowerCase();
const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();

// ============================
// REGISTER USER
// ============================

export const registerUser = async (req: Request, res: Response) => {
  const {
    name,
    email,
    password,
    role,
    phone,
    dob,
    gender,
    bloodGroup,
    allergies,
    conditions,
    emergencyName,
    emergencyPhone,
    nic,
    address,
    city,
    slmcNumber,
    specialization,
    medicalCenterName,
    medicalCenterAddress,
    medicalCenterPhone,
    medicalCenterEmail,
    medicalCenterId,
  } = req.body as RegisterRequestBody;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const normalizedRole = normalizeRole(role);
  const normalizedEmail = normalizeEmail(email);
  const normalizedCenterEmail = normalizeEmail(medicalCenterEmail || email);

  if (normalizedRole === "patient") {
    const patientFieldsPresent =
      phone &&
      dob &&
      gender &&
      bloodGroup &&
      emergencyName &&
      emergencyPhone &&
      nic &&
      address &&
      city;

    if (!patientFieldsPresent) {
      return res
        .status(400)
        .json({ message: "Patient registration requires all patient fields" });
    }
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Ensure patient_profiles table exists (idempotent)
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
        expo_push_token TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS doctors (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        phone TEXT,
        specialization TEXT,
        license_number TEXT,
        expo_push_token TEXT,
        experience_years INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    const existingUser = await client.query(
      "SELECT 1 FROM users WHERE LOWER(email) = $1",
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Email already registered" });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await client.query(
      `
        INSERT INTO users (name, email, password, password_hash, is_password_set, role)
        VALUES ($1, $2, $3::text, $3::text, TRUE, $4)
        RETURNING id, name, email, role
      `,
      [name, normalizedEmail, hashedPassword, normalizedRole]
    );

    const createdUser = newUser.rows[0];
    let resolvedMedicalCenterId: string | null =
      typeof medicalCenterId === "string" && medicalCenterId.trim().length > 0
        ? medicalCenterId.trim()
        : null;

    if (normalizedRole === "medical_center_admin") {
      if (!medicalCenterName) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ message: "Medical center admin registration requires medical center name" });
      }

      const centerResult = await client.query(
        `
          INSERT INTO medical_centers (name, address, phone, email, admin_id)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, name
        `,
        [
          medicalCenterName,
          medicalCenterAddress || null,
          medicalCenterPhone || null,
          normalizedCenterEmail || normalizedEmail,
          createdUser.id,
        ]
      );

      resolvedMedicalCenterId = centerResult.rows[0].id;

      await client.query(
        `
          INSERT INTO medical_center_admins (user_id, medical_center_id)
          VALUES ($1, $2)
          ON CONFLICT (user_id, medical_center_id) DO NOTHING
        `,
        [createdUser.id, resolvedMedicalCenterId]
      );

      await client.query(
        `
          INSERT INTO medical_center_users (user_id, medical_center_id, role, status)
          VALUES ($1, $2, 'medical_center_admin', 'ACTIVE')
          ON CONFLICT (user_id, medical_center_id, role) DO UPDATE
          SET status = EXCLUDED.status
        `,
        [createdUser.id, resolvedMedicalCenterId]
      );
    }

    if (normalizedRole === "patient") {
      await client.query(
        `
          INSERT INTO patient_profiles (
            user_id,
            phone,
            dob,
            gender,
            blood_group,
            allergies,
            conditions,
            emergency_name,
            emergency_phone,
            nic,
            address,
            city
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `,
        [
          createdUser.id,
          phone,
          dob,
          gender,
          bloodGroup,
          allergies,
          conditions,
          emergencyName,
          emergencyPhone,
          nic,
          address,
          city,
        ]
      );
    }

    if (normalizedRole === "doctor") {
      await client.query(
        `
          INSERT INTO doctors (
            user_id,
            phone,
            specialization,
            license_number,
            medical_center_id
          ) VALUES ($1, $2, $3, $4, $5)
        `,
        [
          createdUser.id,
          phone || null,
          specialization || null,
          slmcNumber || null,
          resolvedMedicalCenterId,
        ]
      );
    }

    if (normalizedRole === "receptionist") {
      await client.query(
        `
          INSERT INTO receptionists (user_id, phone, medical_center_id)
          VALUES ($1, $2, $3)
        `,
        [createdUser.id, phone || null, resolvedMedicalCenterId]
      );
    }

    await client.query("COMMIT");

    const token = generateToken({
      ...createdUser,
      medical_center_id: resolvedMedicalCenterId,
    });

    return res.status(201).json({
      message: "User registered successfully",
      token,
      user: {
        ...createdUser,
        medical_center_id: resolvedMedicalCenterId,
      },
    });
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    const dbError = err as DbError;
    console.error("Register Error:", {
      message: dbError.message,
      code: dbError.code || null,
      detail: dbError.detail || null,
      constraint: dbError.constraint || null,
    });

    if (dbError.code === "23505") {
      return res.status(409).json({ message: "Email or medical center record already exists" });
    }

    if (dbError.code === "23503") {
      return res.status(400).json({ message: "Medical center registration references invalid data" });
    }

    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
};

// ============================
// LOGIN USER
// ============================

export const loginUser = async (
  req: Request<never, unknown, LoginRequestBody>,
  res: Response
) => {
  try {
    const { email, password, expoPushToken } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    // Check if user exists
    const userResult = await db.query(
      `
        SELECT
          u.*,
          mca.medical_center_id AS admin_medical_center_id,
          d.medical_center_id AS doctor_medical_center_id,
          r.medical_center_id AS receptionist_medical_center_id
        FROM users u
        LEFT JOIN medical_center_admins mca ON mca.user_id = u.id
        LEFT JOIN doctors d ON d.user_id = u.id
        LEFT JOIN receptionists r ON r.user_id = u.id
        WHERE u.email = $1
      `,
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    const user = userResult.rows[0];

    // Compare passwords
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    if (expoPushToken && typeof expoPushToken === "string") {
      if (user.role === "patient") {
        await db.query(
          `UPDATE patient_profiles SET expo_push_token = $1 WHERE user_id = $2`,
          [expoPushToken, user.id]
        );
      }
      if (user.role === "doctor") {
        await db.query(
          `UPDATE doctors SET expo_push_token = $1 WHERE user_id = $2`,
          [expoPushToken, user.id]
        );
      }
    }

    // Create JWT
    const medicalCenterId =
      user.admin_medical_center_id ??
      user.doctor_medical_center_id ??
      user.receptionist_medical_center_id ??
      null;

    const token = generateToken({
      ...user,
      medical_center_id: medicalCenterId,
    });

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        medical_center_id: medicalCenterId,
      },
    });
  } catch (err: unknown) {
    console.error("Login Error:", (err as HttpError).message);
    return res.status(500).json({ message: "Server error" });
  }
};
