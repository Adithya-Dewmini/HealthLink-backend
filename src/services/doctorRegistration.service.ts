import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { PoolClient } from "pg";
import pool from "../config/db";
import { getCloudinary } from "../config/cloudinary";
import { env } from "../config/env";
import { createAuditLogWithClient } from "./audit.service";
import type { UploadedFile } from "../types/uploads";
import { hashPassword } from "../utils/security";

type AppError = Error & { statusCode?: number };

export type DoctorRegistrationInput = {
  fullName: string;
  nic: string;
  email: string;
  phone: string;
  slmcNumber: string;
  qualification: string;
  specialization: string;
  experienceYears: number;
  workplace: string;
  password: string;
  slmcCertificate: UploadedFile;
  degreeCertificate: UploadedFile;
  idProof: UploadedFile;
};

type UploadedDocument = {
  url: string;
};

const LOCAL_UPLOAD_DIR = path.resolve(process.cwd(), "uploads", "doctor-documents");

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
};

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const normalizeText = (value: unknown) => String(value || "").trim();
const normalizePhone = (value: unknown) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/^\+94/, "0");
const normalizeNic = (value: unknown) => String(value || "").trim().replace(/\s+/g, "").toUpperCase();
const hasCloudinaryConfig = () =>
  Boolean(env.cloudinaryName && env.cloudinaryKey && env.cloudinarySecret);

const ensureValidInput = (input: DoctorRegistrationInput) => {
  if (
    !input.fullName ||
    !input.email ||
    !input.phone ||
    !input.slmcNumber ||
    !input.qualification ||
    !input.specialization ||
    !input.workplace ||
    !input.password
  ) {
    throw createStatusError("All registration fields are required", 400);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    throw createStatusError("A valid email address is required", 400);
  }

  if (input.password.length < 6) {
    throw createStatusError("Password must be at least 6 characters", 400);
  }

  if (!Number.isFinite(input.experienceYears) || input.experienceYears < 0) {
    throw createStatusError("Experience years must be zero or greater", 400);
  }
};

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
  documentType: string
): Promise<UploadedDocument> => {
  await fs.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
  const fileName = `${Date.now()}-${documentType}-${randomUUID()}${getFileExtension(file)}`;
  const destination = path.join(LOCAL_UPLOAD_DIR, fileName);
  await fs.writeFile(destination, file.buffer);

  return {
    url: `/uploads/doctor-documents/${fileName}`,
  };
};

const uploadDocumentToCloudinary = async (
  file: UploadedFile,
  documentType: string
): Promise<UploadedDocument> => {
  const cloudinary = getCloudinary();

  return new Promise<UploadedDocument>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "healthlink/doctor-documents",
        public_id: `${documentType}-${randomUUID()}`,
        resource_type: file.mimetype === "application/pdf" ? "raw" : "image",
      },
      (error, result) => {
        if (error || !result?.secure_url) {
          reject(error || new Error("Document upload failed"));
          return;
        }

        resolve({
          url: result.secure_url,
        });
      }
    );

    stream.end(file.buffer);
  });
};

const uploadDocument = async (file: UploadedFile, documentType: string) => {
  if (hasCloudinaryConfig()) {
    return uploadDocumentToCloudinary(file, documentType);
  }

  return uploadDocumentToLocalStorage(file, documentType);
};

const getExistingDoctorConflicts = async (client: PoolClient, input: DoctorRegistrationInput) => {
  const checks = await Promise.all([
    client.query(`SELECT 1 FROM users WHERE LOWER(email) = $1 LIMIT 1`, [input.email]),
    client.query(`SELECT 1 FROM doctors WHERE LOWER(TRIM(slmc_number)) = LOWER(TRIM($1)) LIMIT 1`, [
      input.slmcNumber,
    ]),
    input.nic
      ? client.query(`SELECT 1 FROM doctors WHERE LOWER(TRIM(nic)) = LOWER(TRIM($1)) LIMIT 1`, [
          input.nic,
        ])
      : Promise.resolve({ rows: [] }),
  ]);
  const [emailResult, slmcResult, nicResult] = checks;

  if (emailResult.rows.length > 0) {
    throw createStatusError("Email already registered", 409);
  }

  if (slmcResult.rows.length > 0) {
    throw createStatusError("SLMC registration number already registered", 409);
  }

  if (nicResult.rows.length > 0) {
    throw createStatusError("NIC already registered", 409);
  }
};

export const registerDoctorWithVerification = async (rawInput: DoctorRegistrationInput) => {
  const input: DoctorRegistrationInput = {
    ...rawInput,
    fullName: normalizeText(rawInput.fullName),
    nic: normalizeNic(rawInput.nic),
    email: normalizeEmail(rawInput.email),
    phone: normalizePhone(rawInput.phone),
    slmcNumber: normalizeText(rawInput.slmcNumber),
    qualification: normalizeText(rawInput.qualification),
    specialization: normalizeText(rawInput.specialization),
    workplace: normalizeText(rawInput.workplace),
    password: String(rawInput.password || ""),
    experienceYears: Number(rawInput.experienceYears || 0),
  };

  ensureValidInput(input);

  const uploadedDocuments = await Promise.all([
    uploadDocument(input.slmcCertificate, "slmc_certificate"),
    uploadDocument(input.degreeCertificate, "degree_certificate"),
    uploadDocument(input.idProof, "id_proof"),
  ]);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await getExistingDoctorConflicts(client, input);

    const passwordHash = await hashPassword(input.password);

    const userResult = await client.query<{
      id: number;
    }>(
      `
        INSERT INTO users (name, email, password, password_hash, is_password_set, role)
        VALUES ($1, $2, $3, $4, TRUE, 'doctor')
        RETURNING id
      `,
      [input.fullName, input.email, passwordHash, passwordHash]
    );

    const userId = userResult.rows[0].id;

    const doctorResult = await client.query<{ id: number }>(
      `
        INSERT INTO doctors (
          user_id,
          phone,
          nic,
          specialization,
          license_number,
          slmc_number,
          experience_years,
          qualifications,
          workplace,
          verification_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
        RETURNING id
      `,
      [
        userId,
        input.phone,
        input.nic,
        input.specialization,
        input.slmcNumber,
        input.slmcNumber,
        input.experienceYears,
        input.qualification,
        input.workplace,
      ]
    );

    const doctorId = doctorResult.rows[0].id;

    await client.query(
      `
        INSERT INTO doctor_documents (
          doctor_id,
          slmc_certificate_url,
          degree_certificate_url,
          id_proof_url
        )
        VALUES ($1, $2, $3, $4)
      `,
      [doctorId, uploadedDocuments[0].url, uploadedDocuments[1].url, uploadedDocuments[2].url]
    );

    await client.query(
      `
        INSERT INTO verification_documents (entity_type, entity_id, document_type, file_url)
        VALUES
          ('doctor', $1, 'slmc_certificate', $2),
          ('doctor', $1, 'degree_certificate', $3),
          ('doctor', $1, 'id_proof', $4)
      `,
      [String(doctorId), uploadedDocuments[0].url, uploadedDocuments[1].url, uploadedDocuments[2].url]
    );

    await client.query(
      `
        INSERT INTO doctor_verifications (doctor_id, status, notes)
        VALUES ($1, 'pending', NULL)
      `,
      [doctorId]
    );

    await createAuditLogWithClient(client, {
      userId,
      action: "doctor_registration_submitted",
    });

    await client.query("COMMIT");

    return {
      success: true,
      message: "Doctor registration submitted successfully",
      doctorId,
      verificationStatus: "pending" as const,
      requiresApproval: true,
      requiresPasswordSetup: false,
      canLogin: true,
      email: input.email,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
