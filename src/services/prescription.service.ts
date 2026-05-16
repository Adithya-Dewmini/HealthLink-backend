import jwt from "jsonwebtoken";
import pool from "../config/db";
import { env } from "../config/env";
import type { PoolClient } from "pg";

const QR_SECRET = env.jwtSecret;
const PRESCRIPTION_QR_TOKEN_TTL = "365d";

type HttpError = Error & { statusCode?: number };
type Queryable = Pick<typeof pool, "query"> | PoolClient;
type PrescriptionQrTokenPayload = {
  prescriptionId: string | number;
  patientId?: number | null;
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

export const createPrescriptionQrToken = (payload: PrescriptionQrTokenPayload) =>
  jwt.sign(
    {
      prescriptionId: Number(payload.prescriptionId),
      patientId: payload.patientId ?? null,
    },
    QR_SECRET,
    { expiresIn: PRESCRIPTION_QR_TOKEN_TTL }
  );

export const getPrescriptionQrMetadata = (qrCode?: string | null) => {
  if (!qrCode) {
    return {
      qrStatus: "unavailable" as const,
      expiresAt: null as string | null,
      isUsable: false,
    };
  }

  try {
    const decoded = jwt.decode(qrCode) as { exp?: number } | null;
    const expiresAt =
      typeof decoded?.exp === "number" ? new Date(decoded.exp * 1000).toISOString() : null;

    if (!expiresAt) {
      return {
        qrStatus: "active" as const,
        expiresAt: null,
        isUsable: true,
      };
    }

    const isExpired = new Date(expiresAt).getTime() <= Date.now();
    return {
      qrStatus: isExpired ? ("expired" as const) : ("active" as const),
      expiresAt,
      isUsable: !isExpired,
    };
  } catch {
    return {
      qrStatus: "invalid" as const,
      expiresAt: null,
      isUsable: false,
    };
  }
};

export const ensurePrescriptionQrToken = async (
  client: Queryable,
  input: {
    prescriptionId: string | number;
    patientId?: number | null;
    qrCode?: string | null;
    isDispensed?: boolean;
  }
) => {
  if (input.isDispensed) {
    return {
      qrToken: null,
      refreshed: false,
      ...getPrescriptionQrMetadata(null),
    };
  }

  const currentMeta = getPrescriptionQrMetadata(input.qrCode);
  if (input.qrCode && currentMeta.isUsable) {
    return {
      qrToken: input.qrCode,
      refreshed: false,
      ...currentMeta,
    };
  }

  const nextToken = createPrescriptionQrToken({
    prescriptionId: input.prescriptionId,
    patientId: input.patientId ?? null,
  });

  await client.query(`UPDATE prescriptions SET qr_code = $1 WHERE id = $2`, [
    nextToken,
    input.prescriptionId,
  ]);

  return {
    qrToken: nextToken,
    refreshed: true,
    ...getPrescriptionQrMetadata(nextToken),
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
  const decoded = jwt.verify(token, QR_SECRET) as { prescriptionId?: number };

  const result = await pool.query(`SELECT * FROM prescriptions WHERE id = $1`, [
    decoded.prescriptionId,
  ]);

  if (result.rows.length === 0) {
    throw createStatusError("Invalid prescription", 404);
  }

  return { prescriptionId: decoded.prescriptionId };
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
    patientId: row.patient_id ?? null,
    qrCode: row.qr_code ?? null,
    isDispensed: Boolean(row.dispensed_at),
  });

  return {
    id: String(row.id),
    qrToken: qrState.qrToken,
    title:
      (typeof row.diagnosis === "string" && row.diagnosis.trim()) ||
      (typeof row.symptoms === "string" && row.symptoms.trim()) ||
      "General Treatment",
    doctorName: row.doctor_name ?? "Doctor",
    specialization: row.specialization ?? "General Physician",
    medicalCenterName: row.medical_center_name ?? null,
    prescribedAt: row.issued_at ?? row.consultation_created_at ?? row.created_at ?? null,
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
    UPDATE prescriptions
    SET dispensed_at = NOW(), dispensed_by = $2
    WHERE id = $1
    RETURNING *
    `,
    [prescriptionId, pharmacistUserId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Prescription not found", 404);
  }

  return result.rows[0];
};
