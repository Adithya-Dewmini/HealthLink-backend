import jwt from "jsonwebtoken";
import pool from "../config/db";
import { env } from "../config/env";
import type { PoolClient } from "pg";

const QR_SECRET = env.jwtSecret;
const PRESCRIPTION_QR_TOKEN_TTL = "365d";
export const PRESCRIPTION_VALIDITY_DAYS = 7;

type HttpError = Error & { statusCode?: number };
type Queryable = Pick<typeof pool, "query"> | PoolClient;
type PrescriptionQrTokenPayload = {
  prescriptionId: string | number;
  consultationId?: string | number | null;
  patientId?: number | null;
  doctorId?: number | null;
  medicalCenterId?: string | null;
};
type DecodedPrescriptionQrToken = {
  prescriptionId?: number;
  consultationId?: number | null;
  patientId?: number | null;
  doctorId?: number | null;
  medicalCenterId?: string | null;
  exp?: number;
};
type PrescriptionQrContext = {
  prescriptionId: string | number;
  consultationId?: string | number | null;
  patientId?: number | null;
  doctorId?: number | null;
  medicalCenterId?: string | null;
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const getStartOfDay = (value: string | Date) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  parsed.setHours(0, 0, 0, 0);
  return parsed;
};

export const getPrescriptionValidityExpiresAt = (issuedAt?: string | Date | null) => {
  if (!issuedAt) return null;

  const issuedDay = getStartOfDay(issuedAt);
  if (!issuedDay) return null;

  return new Date(
    issuedDay.getTime() + (PRESCRIPTION_VALIDITY_DAYS * DAY_MS) - 1
  ).toISOString();
};

export const isPrescriptionExpired = (issuedAt?: string | Date | null) => {
  const expiresAt = getPrescriptionValidityExpiresAt(issuedAt);
  if (!expiresAt) return false;
  return Date.now() > new Date(expiresAt).getTime();
};

export const assertPrescriptionIsValidForUse = (
  issuedAt?: string | Date | null,
  statusCode = 410
) => {
  if (!isPrescriptionExpired(issuedAt)) {
    return;
  }

  throw createStatusError(
    `Prescription has expired. Prescriptions are valid for ${PRESCRIPTION_VALIDITY_DAYS} days from issue date.`,
    statusCode
  );
};

export const createPrescriptionQrToken = (payload: PrescriptionQrTokenPayload) =>
  jwt.sign(
    {
      prescriptionId: Number(payload.prescriptionId),
      consultationId:
        payload.consultationId === null || payload.consultationId === undefined
          ? null
          : Number(payload.consultationId),
      patientId: payload.patientId ?? null,
      doctorId: payload.doctorId ?? null,
      medicalCenterId: payload.medicalCenterId ?? null,
    },
    QR_SECRET,
    { expiresIn: PRESCRIPTION_QR_TOKEN_TTL }
  );

const decodePrescriptionQrToken = (qrCode?: string | null) => {
  if (!qrCode) return null;
  return jwt.decode(qrCode) as DecodedPrescriptionQrToken | null;
};

const normalizeNullableNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizeNullableString = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const tokenMatchesPrescriptionContext = (
  decoded: DecodedPrescriptionQrToken | null,
  context: PrescriptionQrContext
) => {
  if (!decoded?.prescriptionId) {
    return false;
  }

  return (
    normalizeNullableNumber(decoded.prescriptionId) ===
      normalizeNullableNumber(context.prescriptionId) &&
    normalizeNullableNumber(decoded.consultationId) ===
      normalizeNullableNumber(context.consultationId) &&
    normalizeNullableNumber(decoded.patientId) === normalizeNullableNumber(context.patientId) &&
    normalizeNullableNumber(decoded.doctorId) === normalizeNullableNumber(context.doctorId) &&
    normalizeNullableString(decoded.medicalCenterId) ===
      normalizeNullableString(context.medicalCenterId)
  );
};

export const getPrescriptionQrMetadata = (
  qrCode?: string | null,
  options?: {
    issuedAt?: string | Date | null;
    isDispensed?: boolean;
  }
) => {
  const validityExpiresAt = getPrescriptionValidityExpiresAt(options?.issuedAt);

  if (options?.isDispensed) {
    return {
      qrStatus: "unavailable" as const,
      expiresAt: validityExpiresAt,
      isUsable: false,
    };
  }

  if (isPrescriptionExpired(options?.issuedAt)) {
    return {
      qrStatus: "expired" as const,
      expiresAt: validityExpiresAt,
      isUsable: false,
    };
  }

  if (!qrCode) {
    return {
      qrStatus: "unavailable" as const,
      expiresAt: validityExpiresAt,
      isUsable: false,
    };
  }

  try {
    const decoded = jwt.decode(qrCode) as { exp?: number } | null;
    const tokenExpiresAt =
      typeof decoded?.exp === "number" ? new Date(decoded.exp * 1000).toISOString() : null;

    if (!tokenExpiresAt) {
      return {
        qrStatus: "active" as const,
        expiresAt: validityExpiresAt,
        isUsable: true,
      };
    }

    const isExpired = new Date(tokenExpiresAt).getTime() <= Date.now();
    return {
      qrStatus: isExpired ? ("expired" as const) : ("active" as const),
      expiresAt: validityExpiresAt ?? tokenExpiresAt,
      isUsable: !isExpired,
    };
  } catch {
    return {
      qrStatus: "invalid" as const,
      expiresAt: validityExpiresAt,
      isUsable: false,
    };
  }
};

export const ensurePrescriptionQrToken = async (
  client: Queryable,
  input: {
    prescriptionId: string | number;
    consultationId?: string | number | null;
    patientId?: number | null;
    doctorId?: number | null;
    medicalCenterId?: string | null;
    issuedAt?: string | Date | null;
    qrCode?: string | null;
    isDispensed?: boolean;
  }
) => {
  if (input.isDispensed) {
    return {
      qrToken: null,
      refreshed: false,
      ...getPrescriptionQrMetadata(null, {
        issuedAt: input.issuedAt,
        isDispensed: input.isDispensed,
      }),
    };
  }

  const currentMeta = getPrescriptionQrMetadata(input.qrCode, {
    issuedAt: input.issuedAt,
    isDispensed: input.isDispensed,
  });
  const decoded = decodePrescriptionQrToken(input.qrCode);
  const hasExpectedContext = tokenMatchesPrescriptionContext(decoded, input);

  if (currentMeta.qrStatus === "expired") {
    return {
      qrToken: input.qrCode ?? null,
      refreshed: false,
      ...currentMeta,
    };
  }

  if (input.qrCode && currentMeta.isUsable && hasExpectedContext) {
    return {
      qrToken: input.qrCode,
      refreshed: false,
      ...currentMeta,
    };
  }

  const nextToken = createPrescriptionQrToken({
    prescriptionId: input.prescriptionId,
    consultationId: input.consultationId ?? null,
    patientId: input.patientId ?? null,
    doctorId: input.doctorId ?? null,
    medicalCenterId: input.medicalCenterId ?? null,
  });

  await client.query(`UPDATE prescriptions SET qr_code = $1 WHERE id = $2`, [
    nextToken,
    input.prescriptionId,
  ]);

  return {
    qrToken: nextToken,
    refreshed: true,
    ...getPrescriptionQrMetadata(nextToken, {
      issuedAt: input.issuedAt,
      isDispensed: input.isDispensed,
    }),
  };
};

const parseFrequency = (value: unknown) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  return value;
};

export const verifyPrescriptionToken = async (token: string) => {
  const decoded = jwt.verify(token, QR_SECRET) as DecodedPrescriptionQrToken;

  const result = await pool.query<{
    prescription_id: number;
    consultation_id: number | null;
    patient_id: number | null;
    doctor_id: number | null;
    medical_center_id: string | null;
    qr_code: string | null;
    dispensed_at: string | null;
    issued_at: string | null;
    consultation_created_at: string | null;
  }>(
    `
      SELECT
        p.id AS prescription_id,
        p.consultation_id,
        c.patient_id,
        c.doctor_id,
        COALESCE(p.medical_center_id, c.medical_center_id) AS medical_center_id,
        p.qr_code,
        p.dispensed_at,
        p.issued_at,
        c.created_at AS consultation_created_at
      FROM prescriptions p
      LEFT JOIN consultations c
        ON c.id = p.consultation_id
      WHERE p.id = $1
      LIMIT 1
    `,
    [decoded.prescriptionId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Invalid prescription", 404);
  }

  const prescription = result.rows[0];
  if (!prescription.qr_code || prescription.qr_code !== token) {
    throw createStatusError("Prescription QR is no longer active", 401);
  }

  const matchesContext = tokenMatchesPrescriptionContext(decoded, {
    prescriptionId: prescription.prescription_id,
    consultationId: prescription.consultation_id,
    patientId: prescription.patient_id,
    doctorId: prescription.doctor_id,
    medicalCenterId: prescription.medical_center_id,
  });

  if (!matchesContext) {
    throw createStatusError("Prescription QR does not match the consultation", 401);
  }

  assertPrescriptionIsValidForUse(
    prescription.issued_at ?? prescription.consultation_created_at ?? null
  );

  return {
    prescriptionId: prescription.prescription_id,
    consultationId: prescription.consultation_id,
    patientId: prescription.patient_id,
    doctorId: prescription.doctor_id,
    medicalCenterId: prescription.medical_center_id,
    dispensedAt: prescription.dispensed_at,
  };
};

export const getPrescriptionDetails = async (prescriptionId: string, user?: { id?: number; role?: string }) => {
  const prescriptionResult = await pool.query(
    `
    SELECT
      p.*,
      c.patient_id,
      c.doctor_id,
      c.notes,
      c.symptoms,
      c.diagnosis,
      c.medicines,
      c.created_at AS consultation_created_at,
      pu.name AS patient_name,
      du.name AS doctor_name,
      mc.name AS medical_center_name,
      COALESCE(d.specialization, 'General Physician') AS specialization
    FROM prescriptions p
    JOIN consultations c ON c.id = p.consultation_id
    LEFT JOIN users pu ON pu.id = c.patient_id
    LEFT JOIN users du ON du.id = c.doctor_id
    LEFT JOIN doctors d ON d.user_id = c.doctor_id
    LEFT JOIN medical_centers mc ON mc.id = COALESCE(p.medical_center_id, c.medical_center_id)
    WHERE p.id = $1
    `,
    [prescriptionId]
  );

  if (prescriptionResult.rows.length === 0) {
    throw createStatusError("Prescription not found", 404);
  }

  const row = prescriptionResult.rows[0];
  const role = user?.role;
  const userId = user?.id;

  if (role === "patient" || role === "user") {
    if (row.patient_id !== userId) {
      throw createStatusError("Forbidden", 403);
    }
  } else if (role === "doctor") {
    if (row.doctor_id !== userId) {
      throw createStatusError("Forbidden", 403);
    }
  } else if (role !== "pharmacist") {
    throw createStatusError("Forbidden", 403);
  }

  const itemsResult = await pool.query(
    `
    SELECT *
    FROM prescription_items
    WHERE prescription_id = $1
    `,
    [prescriptionId]
  );

  const items =
    itemsResult.rows.length > 0
      ? itemsResult.rows
      : Array.isArray(row?.medicines)
        ? row.medicines
        : [];

  const normalizedMedicines = items.map((item: any, index: number) => {
    const rawDuration = item?.duration ?? item?.days ?? 0;
    const parsedDurationMatch = String(rawDuration).match(/\d+/);
    const parsedDuration = parsedDurationMatch ? Number(parsedDurationMatch[0]) : 0;

    return {
      name: item?.medicine_name ?? item?.name ?? `Medicine ${index + 1}`,
      dosage: item?.dosage ?? item?.dose ?? "Not specified",
      frequency: parseFrequency(item?.frequency ?? item?.freq ?? null),
      duration: Number.isFinite(parsedDuration) ? parsedDuration : 0,
      instructions:
        (typeof item?.instructions === "string" && item.instructions.trim()) ||
        "No instructions",
    };
  });

  const qrState = await ensurePrescriptionQrToken(pool, {
    prescriptionId: row.id,
    consultationId: row.consultation_id ?? null,
    patientId: row.patient_id ?? null,
    doctorId: row.doctor_id ?? null,
    medicalCenterId: row.medical_center_id ?? null,
    issuedAt: row.issued_at ?? row.consultation_created_at ?? row.created_at ?? null,
    qrCode: row.qr_code ?? null,
    isDispensed: Boolean(row.dispensed_at),
  });

  return {
    id: String(row.id),
    consultationId: row.consultation_id ? String(row.consultation_id) : null,
    patientId: row.patient_id ? String(row.patient_id) : null,
    doctorId: row.doctor_id ? String(row.doctor_id) : null,
    medicalCenterId: row.medical_center_id ? String(row.medical_center_id) : null,
    qrToken: qrState.qrToken,
    title:
      (typeof row.diagnosis === "string" && row.diagnosis.trim()) ||
      (typeof row.symptoms === "string" && row.symptoms.trim()) ||
      "General Treatment",
    doctorName: row.doctor_name ?? "Doctor",
    specialization: row.specialization ?? "General Physician",
    medicalCenterName: row.medical_center_name ?? null,
    prescribedAt: row.issued_at ?? row.consultation_created_at ?? row.created_at ?? null,
    consultationCreatedAt: row.consultation_created_at ?? null,
    status: row.dispensed_at ? "COMPLETED" : "ACTIVE",
    qr: {
      status: qrState.qrStatus,
      expiresAt: qrState.expiresAt,
      available: Boolean(qrState.qrToken),
      refreshed: qrState.refreshed,
    },
    medicines: normalizedMedicines,
    prescription: row,
    patient: row.patient_name ?? null,
    doctor: row.doctor_name ?? null,
    notes: row.notes ?? null,
    symptoms: row.symptoms ?? null,
    diagnosis: row.diagnosis ?? null,
  };
};

export const dispensePrescription = async (prescriptionId: string, pharmacistUserId: number) => {
  const result = await pool.query(
    `
    SELECT
      p.id,
      p.dispensed_at,
      p.issued_at,
      c.created_at AS consultation_created_at
    FROM prescriptions p
    LEFT JOIN consultations c
      ON c.id = p.consultation_id
    WHERE p.id = $1
    LIMIT 1
    `,
    [prescriptionId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Prescription not found", 404);
  }

  const row = result.rows[0];
  if (row.dispensed_at) {
    throw createStatusError("Prescription has already been dispensed", 409);
  }

  assertPrescriptionIsValidForUse(row.issued_at ?? row.consultation_created_at ?? null);

  const updateResult = await pool.query(
    `
    UPDATE prescriptions
    SET dispensed_at = NOW(), dispensed_by = $2
    WHERE id = $1
    RETURNING *
    `,
    [prescriptionId, pharmacistUserId]
  );

  return updateResult.rows[0];
};
