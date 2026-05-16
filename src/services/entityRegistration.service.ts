import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { PoolClient } from "pg";
import pool from "../config/db";
import { getCloudinary } from "../config/cloudinary";
import { env } from "../config/env";
import { createAuditLogWithClient } from "./audit.service";
import type { UploadedFile } from "../types/uploads";
import { hashPassword, signAuthToken } from "../utils/security";

type AppError = Error & { statusCode?: number };

type UploadedDocument = {
  url: string;
};

export type RegisterMedicalCenterWithVerificationInput = {
  centerName: string;
  location?: string | null;
  address?: string | null;
  phone?: string | null;
  centerEmail?: string | null;
  adminName: string;
  adminEmail: string;
  password: string;
  specialties?: string[];
  verificationDocument: UploadedFile;
};

export type RegisterPharmacyWithVerificationInput = {
  pharmacyName: string;
  location?: string | null;
  phone?: string | null;
  pharmacyEmail?: string | null;
  ownerName: string;
  ownerEmail: string;
  password: string;
  verificationDocument: UploadedFile;
};

const LOCAL_UPLOAD_DIR = path.resolve(process.cwd(), "uploads", "verification-documents");

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
};

const normalizeText = (value: unknown) => String(value || "").trim();
const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const normalizePhone = (value: unknown) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/^\+94/, "0");

const hasCloudinaryConfig = () =>
  Boolean(env.cloudinaryName && env.cloudinaryKey && env.cloudinarySecret);

const getFileExtension = (file: UploadedFile) => {
  const originalExtension = path.extname(file.originalname || "").trim();
  if (originalExtension) {
    return originalExtension.toLowerCase();
  }

  if (file.mimetype === "application/pdf") {
    return ".pdf";
  }

  if (file.mimetype === "image/png") {
    return ".png";
  }

  if (file.mimetype === "image/webp") {
    return ".webp";
  }

  return ".jpg";
};

const uploadDocumentToLocalStorage = async (
  file: UploadedFile,
  entityType: "medical_center" | "pharmacy"
): Promise<UploadedDocument> => {
  await fs.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
  const fileName = `${Date.now()}-${entityType}-${randomUUID()}${getFileExtension(file)}`;
  const destination = path.join(LOCAL_UPLOAD_DIR, fileName);
  await fs.writeFile(destination, file.buffer);

  return {
    url: `/uploads/verification-documents/${fileName}`,
  };
};

const uploadDocumentToCloudinary = async (
  file: UploadedFile,
  entityType: "medical_center" | "pharmacy"
): Promise<UploadedDocument> => {
  const cloudinary = getCloudinary();

  return new Promise<UploadedDocument>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `healthlink/${entityType}-documents`,
        public_id: `${entityType}-${randomUUID()}`,
        resource_type: file.mimetype === "application/pdf" ? "raw" : "image",
      },
      (error, result) => {
        if (error || !result?.secure_url) {
          reject(error || new Error("Document upload failed"));
          return;
        }

        resolve({ url: result.secure_url });
      }
    );

    stream.end(file.buffer);
  });
};

const uploadDocument = async (
  file: UploadedFile,
  entityType: "medical_center" | "pharmacy"
) => {
  if (hasCloudinaryConfig()) {
    return uploadDocumentToCloudinary(file, entityType);
  }

  return uploadDocumentToLocalStorage(file, entityType);
};

const ensureUserEmailAvailable = async (client: PoolClient, email: string) => {
  const existingUser = await client.query(`SELECT 1 FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
  if (existingUser.rows.length > 0) {
    throw createStatusError("Email already registered", 409);
  }
};

const syncIntegerPrimaryKeySequence = async (
  client: PoolClient,
  tableName: string,
  columnName = "id"
) => {
  await client.query(
    `
      SELECT setval(
        pg_get_serial_sequence($1, $2),
        GREATEST(COALESCE((SELECT MAX(id) FROM ${tableName}), 0), 1),
        true
      )
    `,
    [tableName, columnName]
  );
};

const createAuthResponse = (input: {
  userId: number;
  email: string;
  role: "medical_center_admin" | "pharmacist";
  medicalCenterId?: string | null;
  pharmacyId?: number | null;
  name: string;
  message: string;
  verificationStatus: "pending";
  verificationNotes?: string | null;
}) => {
  const token = signAuthToken({
    id: input.userId,
    email: input.email,
    role: input.role,
    medicalCenterId: input.medicalCenterId ?? null,
    centers:
      input.medicalCenterId && input.role === "medical_center_admin"
        ? [{ id: input.medicalCenterId, role: "medical_center_admin" }]
        : [],
  });

  return {
    success: true,
    message: input.message,
    token,
    verificationStatus: input.verificationStatus,
    requiresApproval: true,
    requiresPasswordSetup: false,
    canLogin: true,
    user: {
      id: input.userId,
      name: input.name,
      email: input.email,
      role: input.role,
      medical_center_id: input.medicalCenterId ?? null,
      pharmacy_id: input.pharmacyId ?? null,
      verification_status: input.verificationStatus,
      status: input.verificationStatus,
      verification_notes: input.verificationNotes ?? null,
    },
  };
};

export const registerMedicalCenterWithVerification = async (
  rawInput: RegisterMedicalCenterWithVerificationInput
) => {
  const input = {
    centerName: normalizeText(rawInput.centerName),
    location: normalizeText(rawInput.location),
    address: normalizeText(rawInput.address),
    phone: normalizePhone(rawInput.phone),
    centerEmail: normalizeEmail(rawInput.centerEmail || rawInput.adminEmail),
    adminName: normalizeText(rawInput.adminName),
    adminEmail: normalizeEmail(rawInput.adminEmail),
    password: String(rawInput.password || ""),
    specialties: Array.isArray(rawInput.specialties)
      ? rawInput.specialties.map((item) => normalizeText(item)).filter(Boolean)
      : [],
    verificationDocument: rawInput.verificationDocument,
  };

  if (!input.centerName || !input.adminName || !input.adminEmail || !input.password) {
    throw createStatusError("Medical center registration is incomplete", 400);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.adminEmail)) {
    throw createStatusError("A valid admin email is required", 400);
  }

  if (input.password.length < 8) {
    throw createStatusError("Password must be at least 8 characters", 400);
  }

  const uploadedDocument = await uploadDocument(input.verificationDocument, "medical_center");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await ensureUserEmailAvailable(client, input.adminEmail);

    const passwordHash = await hashPassword(input.password);
    const userResult = await client.query<{ id: number }>(
      `
        INSERT INTO users (name, email, password, password_hash, is_password_set, role)
        VALUES ($1, $2, $3::text, $4::text, TRUE, 'medical_center_admin')
        RETURNING id
      `,
      [input.adminName, input.adminEmail, passwordHash, passwordHash]
    );

    const userId = userResult.rows[0].id;

    const centerResult = await client.query<{ id: string }>(
      `
        INSERT INTO medical_centers (
          name,
          address,
          phone,
          email,
          admin_id,
          status,
          verification_status,
          verification_notes,
          city
        )
        VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 'pending', NULL, $6)
        RETURNING id
      `,
      [
        input.centerName,
        input.address || input.location || null,
        input.phone || null,
        input.centerEmail || input.adminEmail,
        userId,
        input.location || null,
      ]
    );

    const medicalCenterId = centerResult.rows[0].id;

    await client.query(
      `
        INSERT INTO medical_center_admins (user_id, medical_center_id)
        VALUES ($1, $2)
      `,
      [userId, medicalCenterId]
    );

    await client.query(
      `
        INSERT INTO medical_center_users (user_id, medical_center_id, role, status)
        VALUES ($1, $2, 'medical_center_admin', 'ACTIVE')
      `,
      [userId, medicalCenterId]
    );

    for (const specialty of input.specialties) {
      await client.query(
        `
          INSERT INTO clinic_specialties (clinic_id, name)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `,
        [medicalCenterId, specialty]
      );
    }

    await client.query(
      `
        INSERT INTO verification_documents (entity_type, entity_id, document_type, file_url)
        VALUES ('clinic', $1, 'license_or_certificate', $2)
      `,
      [medicalCenterId, uploadedDocument.url]
    );

    await createAuditLogWithClient(client, {
      userId,
      action: "medical_center_registration_submitted",
    });

    await client.query("COMMIT");

    return createAuthResponse({
      userId,
      email: input.adminEmail,
      role: "medical_center_admin",
      medicalCenterId,
      name: input.adminName,
      message: "Medical center registration submitted successfully",
      verificationStatus: "pending",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const registerPharmacyWithVerification = async (
  rawInput: RegisterPharmacyWithVerificationInput
) => {
  const input = {
    pharmacyName: normalizeText(rawInput.pharmacyName),
    location: normalizeText(rawInput.location),
    phone: normalizePhone(rawInput.phone),
    pharmacyEmail: normalizeEmail(rawInput.pharmacyEmail || rawInput.ownerEmail),
    ownerName: normalizeText(rawInput.ownerName),
    ownerEmail: normalizeEmail(rawInput.ownerEmail),
    password: String(rawInput.password || ""),
    verificationDocument: rawInput.verificationDocument,
  };

  if (!input.pharmacyName || !input.ownerName || !input.ownerEmail || !input.password) {
    throw createStatusError("Pharmacy registration is incomplete", 400);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.ownerEmail)) {
    throw createStatusError("A valid owner email is required", 400);
  }

  if (input.password.length < 8) {
    throw createStatusError("Password must be at least 8 characters", 400);
  }

  const uploadedDocument = await uploadDocument(input.verificationDocument, "pharmacy");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await ensureUserEmailAvailable(client, input.ownerEmail);

    const existingPharmacy = await client.query(
      `
        SELECT 1
        FROM pharmacies
        WHERE LOWER(name) = $1
          AND LOWER(COALESCE(location, '')) = $2
        LIMIT 1
      `,
      [input.pharmacyName.toLowerCase(), input.location.toLowerCase()]
    );

    if (existingPharmacy.rows.length > 0) {
      throw createStatusError("A pharmacy with this name is already registered", 409);
    }

    const passwordHash = await hashPassword(input.password);
    const userResult = await client.query<{ id: number }>(
      `
        INSERT INTO users (name, email, password, password_hash, is_password_set, role)
        VALUES ($1, $2, $3::text, $4::text, TRUE, 'pharmacist')
        RETURNING id
      `,
      [input.ownerName, input.ownerEmail, passwordHash, passwordHash]
    );

    const userId = userResult.rows[0].id;
    await syncIntegerPrimaryKeySequence(client, "pharmacies");
    const pharmacyResult = await client.query<{ id: number }>(
      `
        INSERT INTO pharmacies (
          name,
          location,
          status,
          verification_status,
          verification_notes,
          phone,
          email
        )
        VALUES ($1, $2, 'Inactive', 'pending', NULL, $3, $4)
        RETURNING id
      `,
      [input.pharmacyName, input.location || null, input.phone || null, input.pharmacyEmail || null]
    );

    const pharmacyId = pharmacyResult.rows[0].id;

    await client.query(
      `
        INSERT INTO pharmacist_pharmacies (user_id, pharmacy_id)
        VALUES ($1, $2)
      `,
      [userId, pharmacyId]
    );

    await client.query(
      `
        INSERT INTO verification_documents (entity_type, entity_id, document_type, file_url)
        VALUES ('pharmacy', $1, 'license_or_certificate', $2)
      `,
      [String(pharmacyId), uploadedDocument.url]
    );

    await createAuditLogWithClient(client, {
      userId,
      action: "pharmacy_registration_submitted",
    });

    await client.query("COMMIT");

    return createAuthResponse({
      userId,
      email: input.ownerEmail,
      role: "pharmacist",
      pharmacyId,
      name: input.ownerName,
      message: "Pharmacy registration submitted successfully",
      verificationStatus: "pending",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
