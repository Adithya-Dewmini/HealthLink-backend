import pool from "../config/db";

export const listPatientMedicalHistory = async (patientId: number) => {
  const result = await pool.query(
    `
    SELECT
      c.id AS consultation_id,
      c.created_at,
      c.diagnosis,
      c.notes,
      c.symptoms,
      c.status,
      c.medical_center_id,
      du.name AS doctor_name,
      COALESCE(d.specialization, 'General Physician') AS specialization,
      mc.name AS medical_center_name,
      p.id AS prescription_id,
      p.issued_at,
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
    FROM consultations c
    LEFT JOIN users du ON du.id = c.doctor_id
    LEFT JOIN doctors d ON d.user_id = c.doctor_id
    LEFT JOIN medical_centers mc ON mc.id = c.medical_center_id
    LEFT JOIN prescriptions p ON p.consultation_id = c.id
    LEFT JOIN prescription_items pi ON pi.prescription_id = p.id
    WHERE c.patient_id = $1
      AND COALESCE(LOWER(c.status::text), 'completed') = 'completed'
    GROUP BY
      c.id,
      c.created_at,
      c.diagnosis,
      c.notes,
      c.symptoms,
      c.status,
      c.medical_center_id,
      du.name,
      d.specialization,
      mc.name,
      p.id,
      p.issued_at
    ORDER BY c.created_at DESC
    LIMIT 50
    `,
    [patientId]
  );

  return result.rows.map((row: any) => ({
    consultation_id: row.consultation_id,
    date: row.issued_at ?? row.created_at,
    doctor_name: row.doctor_name ?? "Doctor",
    specialization: row.specialization ?? "General Physician",
    medical_center_id: row.medical_center_id ?? null,
    medical_center_name: row.medical_center_name ?? "Medical Center",
    diagnosis: row.diagnosis ?? null,
    notes: row.notes ?? row.symptoms ?? null,
    status: row.status ?? "completed",
    prescription_id: row.prescription_id ?? null,
    medicines: Array.isArray(row.medicines) ? row.medicines : [],
  }));
};
