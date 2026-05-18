import pool from "../config/db";
import { ensurePrescriptionQrToken, getPrescriptionDetails } from "./prescription.service";

type HttpError = Error & { statusCode?: number };

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

export const listPatientPrescriptions = async (patientId: number, latest: boolean) => {
  const latestFilter = latest ? "AND COALESCE(p.is_seen, false) = false" : "";
  const baseQuery = `
    SELECT
      p.id,
      p.consultation_id,
      COALESCE(p.medical_center_id, c.medical_center_id) AS medical_center_id,
      p.qr_code,
      COALESCE(p.is_seen, false) AS is_seen,
      COALESCE(p.issued_at, c.created_at) AS issued_at,
      p.dispensed_at AS dispensed_at,
      c.created_at,
      c.patient_id,
      c.doctor_id,
      mc.name AS medical_center_name,
      du.name AS doctor_name,
      COALESCE(d.specialization, 'General') AS doctor_specialization,
      COALESCE(
        json_agg(
          json_build_object(
            'name', pi.medicine_name,
            'dosage', pi.dosage,
            'frequency', pi.frequency,
            'duration', pi.duration,
            'instructions', pi.instructions
          )
        ) FILTER (WHERE pi.id IS NOT NULL),
        '[]'::json
      ) AS medicines
    FROM prescriptions p
    JOIN consultations c ON c.id = p.consultation_id
    LEFT JOIN users du ON du.id = c.doctor_id
    LEFT JOIN doctors d ON d.user_id = c.doctor_id
    LEFT JOIN medical_centers mc ON mc.id = COALESCE(p.medical_center_id, c.medical_center_id)
    LEFT JOIN prescription_items pi ON pi.prescription_id = p.id
    WHERE c.patient_id = $1
      AND c.status = 'completed'
    ${latestFilter}
    GROUP BY
      p.id,
      p.consultation_id,
      COALESCE(p.medical_center_id, c.medical_center_id),
      p.qr_code,
      p.is_seen,
      p.issued_at,
      p.dispensed_at,
      c.created_at,
      c.patient_id,
      c.doctor_id,
      mc.name,
      du.name,
      d.specialization
  `;

  const result = latest
    ? await pool.query(`${baseQuery} ORDER BY c.created_at DESC LIMIT 1`, [patientId])
    : await pool.query(`${baseQuery} ORDER BY c.created_at DESC`, [patientId]);

  const rows = result.rows.map((row: any) => ({
    id: row.id,
    consultation_id: row.consultation_id ?? null,
    patient_id: row.patient_id ?? null,
    doctor_id: row.doctor_id ?? null,
    medical_center_id: row.medical_center_id ?? null,
    qrToken: row.qr_code,
    doctor: {
      name: row.doctor_name ?? "Doctor",
      specialization: row.doctor_specialization ?? null,
    },
    createdAt: row.created_at,
    medical_center_name: row.medical_center_name ?? null,
    issuedAt: row.issued_at ?? row.created_at,
    dispensedAt: row.dispensed_at ?? null,
    status: row.dispensed_at ? "Completed" : "Active",
    medicines: Array.isArray(row.medicines) ? row.medicines : [],
    isSeen: row.is_seen ?? false,
  }));

  if (latest && rows[0]?.id) {
    const qrState = await ensurePrescriptionQrToken(pool, {
      prescriptionId: rows[0].id,
      consultationId: rows[0].consultation_id ?? null,
      patientId: rows[0].patient_id ?? null,
      doctorId: rows[0].doctor_id ?? null,
      medicalCenterId: rows[0].medical_center_id ?? null,
      issuedAt: rows[0].issuedAt ?? rows[0].createdAt ?? null,
      qrCode: rows[0].qrToken ?? null,
      isDispensed: Boolean(rows[0].dispensedAt),
    });
    rows[0].qrToken = qrState.qrToken;
  }

  return latest ? rows[0] ?? null : rows;
};

export const getPatientPrescriptionDetail = async (prescriptionId: string, patientId: number) => {
  return getPrescriptionDetails(prescriptionId, { id: patientId, role: "patient" });
};

export const markPatientPrescriptionSeen = async (prescriptionId: string, patientId: number) => {
  const result = await pool.query(
    `
    UPDATE prescriptions p
    SET is_seen = true
    FROM consultations c
    WHERE p.id = $1
      AND p.consultation_id = c.id
      AND c.patient_id = $2
    RETURNING p.id
    `,
    [prescriptionId, patientId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Prescription not found", 404);
  }
};
