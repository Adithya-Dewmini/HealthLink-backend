import pool from "../config/db";
import { getPrescriptionQrMetadata } from "./prescription.service";

type HttpError = Error & { statusCode?: number };

type DoctorPrescriptionListFilters = {
  search?: string;
  status?: string;
  date?: string;
  limit?: number;
  offset?: number;
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

const normalizeStatusFilter = (value?: string) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "all") return null;
  if (normalized === "active" || normalized === "issued" || normalized === "pending") {
    return "active";
  }
  if (normalized === "dispensed" || normalized === "completed") {
    return "dispensed";
  }
  return null;
};

export const listDoctorPrescriptions = async (
  doctorUserId: number,
  filters: DoctorPrescriptionListFilters
) => {
  const whereParts = ["c.doctor_id = $1"];
  const values: Array<string | number> = [doctorUserId];

  const normalizedSearch = String(filters.search || "").trim();
  if (normalizedSearch) {
    values.push(`%${normalizedSearch.toLowerCase()}%`);
    whereParts.push(`LOWER(COALESCE(pu.name, '')) LIKE $${values.length}`);
  }

  const normalizedStatus = normalizeStatusFilter(filters.status);
  if (normalizedStatus === "active") {
    whereParts.push("p.dispensed_at IS NULL");
  } else if (normalizedStatus === "dispensed") {
    whereParts.push("p.dispensed_at IS NOT NULL");
  }

  const normalizedDate = String(filters.date || "").trim();
  if (normalizedDate) {
    values.push(normalizedDate);
    whereParts.push(`COALESCE(p.issued_at, c.created_at)::date = $${values.length}::date`);
  }

  const limit = Number.isFinite(filters.limit) ? Math.max(1, Math.min(filters.limit as number, 100)) : 50;
  const offset = Number.isFinite(filters.offset) ? Math.max(0, filters.offset as number) : 0;

  values.push(limit);
  const limitParam = `$${values.length}`;
  values.push(offset);
  const offsetParam = `$${values.length}`;

  const result = await pool.query(
    `
      SELECT
        p.id,
        p.consultation_id,
        p.medical_center_id,
        p.qr_code,
        p.issued_at,
        p.dispensed_at,
        p.dispensed_by,
        c.patient_id,
        COALESCE(c.created_at, p.issued_at) AS consultation_created_at,
        pu.name AS patient_name,
        pu.profile_image AS patient_profile_image,
        CASE
          WHEN pp.dob IS NULL THEN NULL
          ELSE DATE_PART('year', AGE(pp.dob))::int
        END AS patient_age,
        pp.gender AS patient_gender,
        mc.name AS medical_center_name,
        mc.logo_url AS medical_center_logo_url,
        mc.cover_image_url AS medical_center_cover_image_url,
        COUNT(pi.id)::int AS medicine_count
      FROM prescriptions p
      JOIN consultations c
        ON c.id = p.consultation_id
      LEFT JOIN users pu
        ON pu.id = c.patient_id
      LEFT JOIN patient_profiles pp
        ON pp.user_id = c.patient_id
      LEFT JOIN medical_centers mc
        ON mc.id = COALESCE(p.medical_center_id, c.medical_center_id)
      LEFT JOIN prescription_items pi
        ON pi.prescription_id = p.id
      WHERE ${whereParts.join(" AND ")}
      GROUP BY
        p.id,
        p.consultation_id,
        p.medical_center_id,
        p.qr_code,
        p.issued_at,
        p.dispensed_at,
        p.dispensed_by,
        c.patient_id,
        c.created_at,
        pu.name,
        pu.profile_image,
        pp.dob,
        pp.gender,
        mc.name,
        mc.logo_url,
        mc.cover_image_url
      ORDER BY COALESCE(p.issued_at, c.created_at) DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `,
    values
  );

  return result.rows.map((row) => {
    const qrMeta = getPrescriptionQrMetadata(row.qr_code);
    return {
      id: String(row.id),
      consultationId: row.consultation_id ? String(row.consultation_id) : null,
      patient: {
        id: row.patient_id ? String(row.patient_id) : null,
        name: row.patient_name ?? "Patient",
        age: typeof row.patient_age === "number" ? row.patient_age : null,
        gender: row.patient_gender ?? null,
        profile_image: row.patient_profile_image ?? null,
      },
      medicalCenter: row.medical_center_id
        ? {
            id: String(row.medical_center_id),
            name: row.medical_center_name ?? "Medical Center",
            logo_url: row.medical_center_logo_url ?? null,
            cover_image_url: row.medical_center_cover_image_url ?? null,
          }
        : null,
      issuedAt: row.issued_at ?? row.consultation_created_at ?? null,
      status: row.dispensed_at ? "Dispensed" : "Issued",
      dispensed: Boolean(row.dispensed_at),
      dispensedAt: row.dispensed_at ?? null,
      medicineCount: Number(row.medicine_count ?? 0),
      qrStatus: qrMeta.qrStatus,
      expiresAt: qrMeta.expiresAt,
    };
  });
};

export const getDoctorPrescriptionDetail = async (
  doctorUserId: number,
  prescriptionId: string
) => {
  const result = await pool.query(
    `
      SELECT
        p.id,
        p.consultation_id,
        p.medical_center_id,
        p.qr_code,
        p.issued_at,
        p.dispensed_at,
        p.dispensed_by,
        c.patient_id,
        c.doctor_id,
        c.queue_id,
        c.symptoms,
        c.diagnosis,
        c.notes,
        c.created_at AS consultation_created_at,
        pu.name AS patient_name,
        CASE
          WHEN pp.dob IS NULL THEN NULL
          ELSE DATE_PART('year', AGE(pp.dob))::int
        END AS patient_age,
        pp.gender AS patient_gender,
        pu.profile_image AS patient_profile_image,
        du.name AS doctor_name,
        du.profile_image AS doctor_profile_image,
        COALESCE(d.specialization, 'General Physician') AS doctor_specialization,
        mc.name AS medical_center_name,
        mc.logo_url AS medical_center_logo_url,
        mc.cover_image_url AS medical_center_cover_image_url,
        dispensed_user.name AS dispensed_by_name
      FROM prescriptions p
      JOIN consultations c
        ON c.id = p.consultation_id
      LEFT JOIN users pu
        ON pu.id = c.patient_id
      LEFT JOIN patient_profiles pp
        ON pp.user_id = c.patient_id
      LEFT JOIN users du
        ON du.id = c.doctor_id
      LEFT JOIN doctors d
        ON d.user_id = c.doctor_id
      LEFT JOIN medical_centers mc
        ON mc.id = COALESCE(p.medical_center_id, c.medical_center_id)
      LEFT JOIN users dispensed_user
        ON dispensed_user.id = p.dispensed_by
      WHERE p.id = $1
        AND c.doctor_id = $2
      LIMIT 1
    `,
    [prescriptionId, doctorUserId]
  );

  if (!result.rows.length) {
    throw createStatusError("Prescription not found", 404);
  }

  const row = result.rows[0];

  const itemsResult = await pool.query(
    `
      SELECT
        id,
        medicine_name,
        dosage,
        frequency,
        duration,
        instructions
      FROM prescription_items
      WHERE prescription_id = $1
      ORDER BY id ASC
    `,
    [prescriptionId]
  );

  const qrMeta = getPrescriptionQrMetadata(row.qr_code);

  return {
    id: String(row.id),
    consultationId: row.consultation_id ? String(row.consultation_id) : null,
    queueId: row.queue_id ? String(row.queue_id) : null,
    issuedAt: row.issued_at ?? row.consultation_created_at ?? null,
    status: row.dispensed_at ? "Dispensed" : "Issued",
    dispensed: {
      isDispensed: Boolean(row.dispensed_at),
      dispensedAt: row.dispensed_at ?? null,
      dispensedBy: row.dispensed_by
        ? {
            id: String(row.dispensed_by),
            name: row.dispensed_by_name ?? "Pharmacist",
          }
        : null,
    },
    qr: {
      status: qrMeta.qrStatus,
      expiresAt: qrMeta.expiresAt,
      available: Boolean(row.qr_code),
    },
    patient: {
      id: row.patient_id ? String(row.patient_id) : null,
      name: row.patient_name ?? "Patient",
      age: typeof row.patient_age === "number" ? row.patient_age : null,
      gender: row.patient_gender ?? null,
      profile_image: row.patient_profile_image ?? null,
    },
    doctor: {
      id: row.doctor_id ? String(row.doctor_id) : String(doctorUserId),
      name: row.doctor_name ?? "Doctor",
      specialization: row.doctor_specialization ?? "General Physician",
      profile_image: row.doctor_profile_image ?? null,
    },
    medicalCenter: row.medical_center_id
      ? {
          id: String(row.medical_center_id),
          name: row.medical_center_name ?? "Medical Center",
          logo_url: row.medical_center_logo_url ?? null,
          cover_image_url: row.medical_center_cover_image_url ?? null,
        }
      : null,
    consultation: {
      symptoms: row.symptoms ?? null,
      diagnosis: row.diagnosis ?? null,
      notes: row.notes ?? null,
    },
    medicines: itemsResult.rows.map((item) => ({
      id: String(item.id),
      name: item.medicine_name ?? "Medicine",
      dosage: item.dosage ?? null,
      frequency: item.frequency ?? null,
      duration: item.duration ?? null,
      instructions: item.instructions ?? null,
    })),
  };
};
