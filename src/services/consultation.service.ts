import type { PoolClient } from "pg";
import pool from "../config/db";
import { env } from "../config/env";
import { createAuditLogWithClient } from "./audit.service";
import { io } from "../server";
import QRCode from "qrcode";
import { filterExpoTokens, sendExpoPush } from "../utils/expoPush";
import { BOOKING_STATUS, updateNearestBookingStatus } from "../utils/bookingLifecycle";
import {
  SOCKET_EVENTS,
  emitPrescriptionUpdated,
  logRealtimeEmit,
} from "./realtime.service";
import { createPrescriptionQrToken, ensurePrescriptionQrToken } from "./prescription.service";

const doctorRoom = (doctorId: number | string) => `doctor-${doctorId}`;
const receptionRoom = "reception";

type HttpError = Error & { statusCode?: number; code?: string };
type Queryable = {
  query: <TRow = any>(text: string, params?: unknown[]) => Promise<{ rows: TRow[] }>;
};

const createStatusError = (message: string, statusCode: number, code?: string) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const normalizeMedicineList = (value: unknown): any[] => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
};

const buildPrescriptionDeepLink = (qrToken: string | null) =>
  qrToken ? `https://healthlink.app/prescription/${qrToken}` : null;

export const normalizeMedName = (value: string) => value.trim().toLowerCase();

export const validateMedicines = (medicines: any[], requireNames: boolean) => {
  if (!Array.isArray(medicines)) return "medicines must be an array";
  if (requireNames && medicines.length === 0) return "medicines cannot be empty";
  const names: string[] = [];
  for (const med of medicines) {
    const name = med?.name ?? med?.medicine_name;
    if (!name || typeof name !== "string" || !name.trim()) {
      if (requireNames) {
        return "medicine name is required for each item";
      }
      continue;
    }
    names.push(normalizeMedName(name));
  }
  if (names.length > 0) {
    const unique = new Set(names);
    if (unique.size !== names.length) {
      return "duplicate medicines detected";
    }
  }
  return null;
};

export const findMedicineConflicts = async (names: string[]) => {
  if (names.length === 0) return [];
  const result = await pool.query<{ name: string; conflicts: string[] | null }>(
    `
    SELECT name, conflicts
    FROM medicines
    WHERE LOWER(name) = ANY($1)
    `,
    [names]
  );
  const nameSet = new Set(names);
  const conflicts: { medicine: string; with: string[] }[] = [];
  for (const row of result.rows) {
    const rowName = normalizeMedName(row.name);
    const rowConflicts = Array.isArray(row.conflicts) ? row.conflicts : [];
    const matched = rowConflicts
      .map((c) => normalizeMedName(c))
      .filter((c) => nameSet.has(c));
    if (matched.length > 0) {
      conflicts.push({ medicine: row.name, with: matched });
    }
  }
  return conflicts;
};

const broadcastQueueUpdate = (
  doctorId: number | string,
  payload: {
    queueId: number;
    sessionId?: number | null;
    patientId?: number | null;
    type: string;
    triggeredBy?: string;
  }
) => {
  const enrichedPayload = { ...payload, doctorId };
  for (const room of [doctorRoom(doctorId), receptionRoom]) {
    io.to(room).emit(SOCKET_EVENTS.queueUpdate, enrichedPayload);
    logRealtimeEmit(SOCKET_EVENTS.queueUpdate, room, enrichedPayload);
  }
  if (payload.patientId) {
    const room = `patient_${payload.patientId}`;
    io.to(room).emit(SOCKET_EVENTS.queueUpdate, enrichedPayload);
    logRealtimeEmit(SOCKET_EVENTS.queueUpdate, room, enrichedPayload);
  }
};

export const searchMedicines = async (query: string, limit: number) => {
  if (!query) {
    const result = await pool.query(`SELECT id, name FROM medicines ORDER BY name ASC LIMIT $1`, [
      limit,
    ]);
    return result.rows;
  }

  const result = await pool.query(
    `
    SELECT id, name
    FROM medicines
    WHERE name ILIKE $1
    ORDER BY name ASC
    LIMIT $2
    `,
    [`%${query}%`, limit]
  );
  return result.rows;
};

const requireDoctorProfile = async (client: PoolClient | typeof pool, userId: number) => {
  const doctorResult = await client.query<{ id: number; medical_center_id: string | null }>(
    `SELECT id, medical_center_id FROM doctors WHERE user_id = $1`,
    [userId]
  );

  if (doctorResult.rows.length === 0) {
    throw createStatusError("Doctor profile not found", 400, "DOCTOR_NOT_ASSIGNED");
  }

  return doctorResult.rows[0];
};

const ensureQueuePatientContext = async (
  client: PoolClient | typeof pool,
  input: { queueId: number; patientId?: number | null; doctorUserId: number }
) => {
  const result = await client.query<{
    id: number;
    patient_id: number;
    doctor_id: number;
    consultation_id: number | null;
    medical_center_id: string | null;
    schedule_id: number | null;
    status: string;
  }>(
    `
    SELECT
      qp.id,
      qp.patient_id,
      qp.doctor_id,
      qp.consultation_id,
      qp.medical_center_id,
      q.schedule_id,
      qp.status
    FROM queue_patients qp
    JOIN queues q ON q.id = qp.queue_id
    WHERE qp.queue_id = $1
      AND qp.doctor_id = $2
      AND ($3::int IS NULL OR qp.patient_id = $3)
      AND qp.status = 'WITH_DOCTOR'
    LIMIT 1
    `,
    [input.queueId, input.doctorUserId, input.patientId ?? null]
  );

  const row = result.rows[0];
  if (!row) {
    throw createStatusError(
      "No active consultation patient found for this doctor and queue",
      409,
      "PATIENT_NOT_CALLED"
    );
  }

  return row;
};

export const getDoctorConsultationContext = async (queueId: number, doctorUserId: number) => {
  const queuePatientContext = await ensureQueuePatientContext(pool, { queueId, doctorUserId });

  const currentPatientResult = await pool.query(
    `
    SELECT
      qp.patient_id,
      qp.id AS queue_patient_id,
      qp.token_number,
      qp.status AS queue_patient_status,
      qp.checked_in_at,
      qp.started_at,
      qp.complaint,
      qp.is_walkin,
      q.status AS queue_status,
      q.schedule_id,
      q.shift_date::text AS session_date,
      u.name,
      u.profile_image,
      CASE
        WHEN pp.dob IS NULL THEN NULL
        ELSE DATE_PART('year', AGE(pp.dob))::int
      END AS age,
      pp.gender,
      pp.blood_group,
      pp.conditions,
      pp.allergies,
      mc.name AS medical_center_name,
      s.start_time::text AS session_start,
      s.end_time::text AS session_end,
      b.id AS appointment_id,
      b.status AS appointment_status,
      b.time::text AS appointment_time,
      c.id AS consultation_id,
      c.status AS consultation_status,
      c.symptoms AS consultation_symptoms,
      c.diagnosis AS consultation_diagnosis,
      c.notes AS consultation_notes,
      c.medicines AS consultation_medicines,
      p.id AS prescription_id,
      p.issued_at::text AS prescription_issued_at,
      p.dispensed_at::text AS prescription_dispensed_at
    FROM queue_patients qp
    JOIN queues q ON q.id = qp.queue_id
    JOIN users u ON qp.patient_id = u.id
    LEFT JOIN patient_profiles pp ON pp.user_id = u.id
    LEFT JOIN medical_center_doctor_schedule s ON s.id = q.schedule_id
    LEFT JOIN medical_centers mc
      ON mc.id = COALESCE(q.medical_center_id, qp.medical_center_id, s.medical_center_id)
    LEFT JOIN bookings b
      ON b.patient_id = qp.patient_id
     AND b.session_id = q.schedule_id
     AND b.date = q.shift_date
     AND b.doctor_id = q.doctor_id
    LEFT JOIN consultations c ON c.id = qp.consultation_id
    LEFT JOIN prescriptions p ON p.consultation_id = c.id
    WHERE qp.queue_id = $1 AND qp.status = 'WITH_DOCTOR'
    LIMIT 1
    `,
    [queueId]
  );

  if (currentPatientResult.rows.length === 0) {
    throw createStatusError("No active patient for this queue", 404, "PATIENT_NOT_CALLED");
  }

  const patientRow = currentPatientResult.rows[0];
  const toList = (value: unknown) =>
    typeof value === "string"
      ? value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      : Array.isArray(value)
        ? value
        : [];

  const visitsResult = await pool.query(
    `
    SELECT created_at, diagnosis, notes
    FROM consultations
    WHERE patient_id = $1
    ORDER BY created_at DESC
    LIMIT 5
    `,
    [patientRow.patient_id]
  );

  const medicationsResult = await pool.query(
    `
    SELECT pi.medicine_name
    FROM prescriptions p
    JOIN prescription_items pi ON pi.prescription_id = p.id
    JOIN consultations c ON c.id = p.consultation_id
    WHERE c.patient_id = $1
    ORDER BY p.issued_at DESC
    LIMIT 5
    `,
    [patientRow.patient_id]
  );

  return {
    patient: {
      id: patientRow.patient_id,
      queuePatientId: patientRow.queue_patient_id,
      name: patientRow.name,
      age: patientRow.age,
      gender: patientRow.gender,
      bloodGroup: patientRow.blood_group,
      profile_image: patientRow.profile_image ?? null,
    },
    conditions: toList(patientRow.conditions),
    allergies: toList(patientRow.allergies),
    visits: visitsResult.rows.map((visit: any) => ({
      date: visit.created_at,
      diagnosis: visit.diagnosis,
      notes: visit.notes,
    })),
    medications: medicationsResult.rows.map((row: any) => row.medicine_name),
    queue: {
      queueId,
      queuePatientId: patientRow.queue_patient_id,
      tokenNumber: patientRow.token_number ?? null,
      patientStatus: patientRow.queue_patient_status ?? null,
      queueStatus: patientRow.queue_status ?? null,
      checkedInAt: patientRow.checked_in_at ?? null,
      startedAt: patientRow.started_at ?? null,
      complaint: patientRow.complaint ?? null,
      isWalkIn: Boolean(patientRow.is_walkin),
    },
    appointment: {
      id: patientRow.appointment_id ?? null,
      time: patientRow.appointment_time ?? null,
      status: patientRow.appointment_status ?? null,
    },
    session: {
      id: patientRow.schedule_id ?? null,
      date: patientRow.session_date ?? null,
      startTime: patientRow.session_start ?? null,
      endTime: patientRow.session_end ?? null,
      medicalCenterName: patientRow.medical_center_name ?? null,
    },
    consultation: {
      id: patientRow.consultation_id ?? queuePatientContext.consultation_id ?? null,
      status: patientRow.consultation_status ?? "draft",
      symptoms: patientRow.consultation_symptoms ?? null,
      diagnosis: patientRow.consultation_diagnosis ?? null,
      notes: patientRow.consultation_notes ?? null,
      medicines: normalizeMedicineList(patientRow.consultation_medicines),
      prescriptionId: patientRow.prescription_id ?? null,
      prescriptionIssuedAt: patientRow.prescription_issued_at ?? null,
      prescriptionDispensedAt: patientRow.prescription_dispensed_at ?? null,
      prescriptionIssued: Boolean(patientRow.prescription_id),
    },
  };
};

export const createConsultationRecord = async (options: {
  userId: number;
  patientId: number;
  queueId?: number | null;
  symptoms?: string | null;
  diagnosis?: string | null;
  notes?: string | null;
  medicines?: any[];
}) => {
  const { userId, patientId, queueId, symptoms, diagnosis, notes, medicines } = options;

  if (medicines !== undefined) {
    const validationError = validateMedicines(medicines, false);
    if (validationError) {
      throw createStatusError(validationError, 400, "PRESCRIPTION_REQUIRED_FIELDS");
    }
  }

  const doctorProfile = await requireDoctorProfile(pool, userId);

  if (queueId) {
    const queueContext = await ensureQueuePatientContext(pool, {
      queueId,
      patientId,
      doctorUserId: userId,
    });

    if (queueContext.consultation_id) {
      const existingResult = await pool.query(
        `
        UPDATE consultations
        SET symptoms = COALESCE($2, symptoms),
            diagnosis = COALESCE($3, diagnosis),
            notes = COALESCE($4, notes),
            medicines = COALESCE($5, medicines),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [
          queueContext.consultation_id,
          symptoms ?? null,
          diagnosis ?? null,
          notes ?? null,
          medicines ? JSON.stringify(medicines) : null,
        ]
      );

      if (existingResult.rows[0]) {
        return existingResult.rows[0];
      }
    }
  }

  const result = await pool.query(
    `
    INSERT INTO consultations
      (patient_id, doctor_id, queue_id, symptoms, diagnosis, notes, medicines, medical_center_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
    `,
    [
      patientId,
      userId,
      queueId ?? null,
      symptoms ?? null,
      diagnosis ?? null,
      notes ?? null,
      Array.isArray(medicines) ? JSON.stringify(medicines) : JSON.stringify([]),
      doctorProfile.medical_center_id ?? null,
    ]
  );

  const consultation = result.rows[0];

  if (queueId) {
    await pool.query(
      `
      UPDATE queue_patients
      SET consultation_id = $1
      WHERE queue_id = $2 AND patient_id = $3 AND status = 'WITH_DOCTOR'
      `,
      [consultation.id, queueId, patientId]
    );
  }

  return consultation;
};

export const updateConsultationMedicines = async (consultationId: string, medicines: any[]) => {
  const validationError = validateMedicines(medicines, false);
  if (validationError) {
    throw createStatusError(validationError, 400, "PRESCRIPTION_REQUIRED_FIELDS");
  }

  const result = await pool.query(
    `
    UPDATE consultations
    SET medicines = $2, updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [consultationId, JSON.stringify(medicines)]
  );

  return result.rows[0] ?? null;
};

export const updateConsultationRecord = async (options: {
  userId?: number;
  consultationId: string;
  symptoms?: string | null;
  diagnosis?: string | null;
  notes?: string | null;
  medicines?: any[];
}) => {
  const { consultationId, symptoms, diagnosis, notes, medicines, userId } = options;

  if (medicines !== undefined) {
    const validationError = validateMedicines(medicines, true);
    if (validationError) {
      throw createStatusError(validationError, 400, "PRESCRIPTION_REQUIRED_FIELDS");
    }
  }

  const currentResult = await pool.query(
    `
    SELECT *
    FROM consultations
    WHERE id = $1
    LIMIT 1
    `,
    [consultationId]
  );

  if (currentResult.rows.length === 0) {
    throw createStatusError("Consultation not found", 404, "CONSULTATION_NOT_FOUND");
  }

  let consultation = currentResult.rows[0];
  if (userId) {
    const client = await pool.connect();
    try {
      consultation = await ensureDoctorOwnsConsultation(client, consultation, userId);
    } finally {
      client.release();
    }
  }

  if (String(consultation.status || "").toLowerCase() === "completed") {
    throw createStatusError("Consultation is already completed", 409, "CONSULTATION_ALREADY_COMPLETED");
  }

  if (consultation.queue_id) {
    await ensureQueuePatientContext(pool, {
      queueId: Number(consultation.queue_id),
      patientId: consultation.patient_id ? Number(consultation.patient_id) : null,
      doctorUserId: consultation.doctor_id ? Number(consultation.doctor_id) : userId ?? 0,
    });
  }

  const result = await pool.query(
    `
    UPDATE consultations
    SET symptoms = COALESCE($2, symptoms),
        diagnosis = COALESCE($3, diagnosis),
        notes = COALESCE($4, notes),
        medicines = COALESCE($5, medicines),
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [
      consultationId,
      symptoms ?? null,
      diagnosis ?? null,
      notes ?? null,
      medicines ? JSON.stringify(medicines) : null,
    ]
  );

  return result.rows[0];
};

const ensureDoctorOwnsConsultation = async (
  client: PoolClient,
  consultation: any,
  userId: number
) => {
  const doctorProfile = await client.query<{ id: number }>(`SELECT id FROM doctors WHERE user_id = $1`, [
    userId,
  ]);
  const doctorProfileId = doctorProfile.rows[0]?.id ?? null;

  if (consultation.doctor_id) {
    if (consultation.doctor_id === userId) {
      return consultation;
    }

    if (doctorProfileId && consultation.doctor_id === doctorProfileId) {
      const normalized = await client.query(
        `
        UPDATE consultations
        SET doctor_id = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [consultation.id, userId]
      );
      return normalized.rows[0] ?? consultation;
    }

    throw createStatusError("Not your consultation", 403, "NOT_ALLOWED");
  }

  const assigned = await client.query(
    `
    UPDATE consultations
    SET doctor_id = $2, updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [consultation.id, userId]
  );

  return assigned.rows[0] ?? consultation;
};

const insertPrescriptionItems = async (client: PoolClient, prescriptionId: number, medicines: any[]) => {
  for (const med of medicines) {
    const medicineName = med.name ?? med.medicine_name ?? null;
    let medicineId: number | null = null;

    if (typeof medicineName === "string" && medicineName.trim()) {
      const medicineLookup = await client.query<{ id: number }>(
        `SELECT id FROM medicines WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [medicineName.trim()]
      );
      medicineId = medicineLookup.rows[0]?.id ? Number(medicineLookup.rows[0].id) : null;
    }

    await client.query(
      `
      INSERT INTO prescription_items
        (prescription_id, medicine_id, medicine_name, quantity, dosage, frequency, duration, instructions)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        prescriptionId,
        medicineId,
        medicineName,
        Number(med.quantity ?? med.qty ?? 1) > 0 ? Number(med.quantity ?? med.qty ?? 1) : 1,
        med.dosage ?? med.dose ?? null,
        med.frequency ?? med.freq ?? null,
        med.duration ?? med.days ?? null,
        med.instructions ?? null,
      ]
    );
  }
};

const syncPrescriptionItems = async (
  client: PoolClient,
  prescriptionId: number,
  medicines: any[]
) => {
  await client.query(`DELETE FROM prescription_items WHERE prescription_id = $1`, [prescriptionId]);

  if (Array.isArray(medicines) && medicines.length > 0) {
    await insertPrescriptionItems(client, prescriptionId, medicines);
  }
};

const ensurePrescriptionForConsultation = async (options: {
  client: PoolClient;
  consultation: any;
  medicines: any[];
  userId: number;
}) => {
  const { client, consultation, medicines, userId } = options;
  const existingPrescription = await client.query<{
    id: number;
    qr_code: string | null;
    dispensed_at: string | null;
  }>(
    `
    SELECT id, qr_code, dispensed_at
    FROM prescriptions
    WHERE consultation_id = $1
    LIMIT 1
    FOR UPDATE
    `,
    [consultation.id]
  );

  let prescriptionId = existingPrescription.rows[0]?.id ?? null;

  if (!prescriptionId) {
    const prescriptionResult = await client.query<{ id: number }>(
      `
      INSERT INTO prescriptions (consultation_id, qr_code, medical_center_id, status)
      VALUES ($1, $2, $3, 'issued')
      RETURNING id
      `,
      [consultation.id, "", consultation.medical_center_id ?? null]
    );

    prescriptionId = prescriptionResult.rows[0].id;
  } else {
    await client.query(
      `
      UPDATE prescriptions
      SET status = CASE WHEN dispensed_at IS NULL THEN 'issued' ELSE status END
      WHERE id = $1
      `,
      [prescriptionId]
    );
  }

  await syncPrescriptionItems(client, prescriptionId, medicines);

  const qrState = await ensurePrescriptionQrToken(client, {
    prescriptionId,
    consultationId: consultation.id,
    patientId: consultation.patient_id,
    doctorId: consultation.doctor_id,
    medicalCenterId: consultation.medical_center_id ?? null,
    qrCode: existingPrescription.rows[0]?.qr_code ?? null,
    isDispensed: Boolean(existingPrescription.rows[0]?.dispensed_at),
  });

  await createAuditLogWithClient(client, {
    actorUserId: userId,
    actorRole: "doctor",
    userId,
    action: existingPrescription.rows[0]?.id ? "prescription_updated" : "prescription_created",
    entityType: "prescription",
    entityId: prescriptionId,
    metadata: {
      consultationId: consultation.id,
      patientId: consultation.patient_id,
      queueId: consultation.queue_id ?? null,
      medicineCount: Array.isArray(medicines) ? medicines.length : 0,
    },
  });

  const qrData = buildPrescriptionDeepLink(qrState.qrToken);
  const qrImage = qrData ? await QRCode.toDataURL(qrData) : null;

  return {
    prescriptionId,
    qrToken: qrState.qrToken,
    qrData,
    qrImage,
    created: !existingPrescription.rows[0]?.id,
  };
};

export const issuePrescriptionForConsultationRecord = async (
  consultationId: string,
  userId: number,
  medicines?: any[]
) => {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const consultationResult = await client.query(
      `
      SELECT *
      FROM consultations
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [consultationId]
    );

    if (consultationResult.rows.length === 0) {
      throw createStatusError("Consultation not found", 404, "CONSULTATION_NOT_FOUND");
    }

    let consultation = consultationResult.rows[0];
    consultation = await ensureDoctorOwnsConsultation(client, consultation, userId);

    if (String(consultation.status || "").toLowerCase() === "completed") {
      throw createStatusError("Consultation is already completed", 409, "CONSULTATION_ALREADY_COMPLETED");
    }

    if (!consultation.queue_id || !consultation.patient_id) {
      throw createStatusError("Consultation is not linked to an active queue entry", 409, "PATIENT_NOT_CALLED");
    }

    const queueContext = await ensureQueuePatientContext(client, {
      queueId: Number(consultation.queue_id),
      patientId: Number(consultation.patient_id),
      doctorUserId: userId,
    });

    if (queueContext.consultation_id && String(queueContext.consultation_id) !== String(consultation.id)) {
      throw createStatusError("Queue entry is linked to a different consultation", 409, "PATIENT_NOT_CALLED");
    }

    const medsFromBody = Array.isArray(medicines) ? medicines : null;
    const medsFromDb = normalizeMedicineList(consultation.medicines);
    const meds = medsFromBody ?? medsFromDb;

    const validationError = validateMedicines(meds, true);
    if (validationError) {
      throw createStatusError(validationError, 400, "PRESCRIPTION_REQUIRED_FIELDS");
    }

    if (!Array.isArray(meds) || meds.length === 0) {
      throw createStatusError(
        "Add at least one medicine before completing this consultation",
        400,
        "PRESCRIPTION_REQUIRED_FIELDS"
      );
    }

    const conflictList = await findMedicineConflicts(
      meds.map((med: any) => normalizeMedName(med?.name ?? med?.medicine_name))
    );
    if (conflictList.length > 0) {
      throw Object.assign(createStatusError("Medicine conflict detected", 400), {
        conflicts: conflictList,
      });
    }

    consultation = (
      await client.query(
        `
        UPDATE consultations
        SET symptoms = COALESCE($2, symptoms),
            diagnosis = COALESCE($3, diagnosis),
            notes = COALESCE($4, notes),
            medicines = $5,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [
          consultation.id,
          consultation.symptoms ?? null,
          consultation.diagnosis ?? null,
          consultation.notes ?? null,
          JSON.stringify(meds),
        ]
      )
    ).rows[0];

    const prescription = await ensurePrescriptionForConsultation({
      client,
      consultation,
      medicines: meds,
      userId,
    });

    await client.query(
      `UPDATE consultations SET status = 'active' WHERE id = $1 AND COALESCE(status, 'draft') <> 'completed'`,
      [consultation.id]
    );

    await updateNearestBookingStatus(client, {
      doctorId: Number(consultation.doctor_id),
      patientId: Number(consultation.patient_id),
      nextStatus: BOOKING_STATUS.IN_PROGRESS,
      allowedCurrentStatuses: [BOOKING_STATUS.IN_PROGRESS, BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.BOOKED],
    });

    await client.query("COMMIT");
    committed = true;

    emitPrescriptionUpdated({
      prescriptionId: prescription.prescriptionId,
      patientId: consultation.patient_id,
      status: "issued",
      metadata: {
        consultationId: consultation.id,
        queueId: consultation.queue_id ?? null,
      },
    });

    try {
      if (consultation.patient_id) {
        io.to(`patient_${consultation.patient_id}`).emit("prescription:ready", {
          patientId: consultation.patient_id,
          prescriptionId: prescription.prescriptionId,
        });
      }
    } catch (error) {
      console.error("Prescription socket emit error:", error);
    }

    return {
      success: true,
      message: "Prescription issued successfully",
      consultationId: consultation.id,
      prescriptionId: prescription.prescriptionId,
      qr: prescription.qrImage,
      qrData: prescription.qrData,
      token: prescription.qrToken,
    };
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
};

export const completeConsultationRecord = async (
  consultationId: string,
  userId: number,
  medicines?: any[]
) => {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");

    const consultationResult = await client.query(
      `
      SELECT *
      FROM consultations
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [consultationId]
    );

    if (consultationResult.rows.length === 0) {
      throw createStatusError("Consultation not found", 404, "CONSULTATION_NOT_FOUND");
    }

    let consultation = consultationResult.rows[0];
    consultation = await ensureDoctorOwnsConsultation(client, consultation, userId);

    if (String(consultation.status || "").toLowerCase() === "completed") {
      throw createStatusError("Consultation is already completed", 409, "CONSULTATION_ALREADY_COMPLETED");
    }

    if (!consultation.queue_id || !consultation.patient_id) {
      throw createStatusError("Consultation is not linked to an active queue entry", 409, "PATIENT_NOT_CALLED");
    }

    const queueContext = await ensureQueuePatientContext(client, {
      queueId: Number(consultation.queue_id),
      patientId: Number(consultation.patient_id),
      doctorUserId: userId,
    });

    if (
      queueContext.consultation_id &&
      String(queueContext.consultation_id) !== String(consultation.id)
    ) {
      throw createStatusError("Queue entry is linked to a different consultation", 409, "PATIENT_NOT_CALLED");
    }

    const medsFromBody = Array.isArray(medicines) ? medicines : null;
    const medsFromDb = normalizeMedicineList(consultation.medicines);
    const meds = medsFromBody ?? medsFromDb;

    if (meds.length > 0) {
      const validationError = validateMedicines(meds, true);
      if (validationError) {
        throw createStatusError(validationError, 400, "PRESCRIPTION_REQUIRED_FIELDS");
      }

      const conflictList = await findMedicineConflicts(
        meds.map((med: any) => normalizeMedName(med?.name ?? med?.medicine_name))
      );

      if (conflictList.length > 0) {
        throw Object.assign(createStatusError("Medicine conflict detected", 400), {
          conflicts: conflictList,
        });
      }
    }

    consultation = (
      await client.query(
        `
        UPDATE consultations
        SET status = 'completed',
            symptoms = COALESCE($2, symptoms),
            diagnosis = COALESCE($3, diagnosis),
            notes = COALESCE($4, notes),
            medicines = $5,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [
          consultation.id,
          consultation.symptoms ?? null,
          consultation.diagnosis ?? null,
          consultation.notes ?? null,
          JSON.stringify(meds),
        ]
      )
    ).rows[0];

    let prescription: null | {
      prescriptionId: number;
      qrToken: string | null;
      qrData: string | null;
      qrImage: string | null;
      created: boolean;
    } = null;

    if (meds.length > 0) {
      prescription = await ensurePrescriptionForConsultation({
        client,
        consultation,
        medicines: meds,
        userId,
      });
    }

    await client.query(
      `
      UPDATE queue_patients
      SET status = 'COMPLETED', completed_at = NOW(), consultation_id = $1
      WHERE id = $2
        AND status = 'WITH_DOCTOR'
      `,
      [consultation.id, queueContext.id]
    );

    await updateNearestBookingStatus(client, {
      doctorId: Number(consultation.doctor_id),
      patientId: Number(consultation.patient_id),
      nextStatus: BOOKING_STATUS.COMPLETED,
      allowedCurrentStatuses: [BOOKING_STATUS.IN_PROGRESS],
      setEndedAt: true,
    });

    await client.query("COMMIT");
    committed = true;

    if (prescription) {
      emitPrescriptionUpdated({
        prescriptionId: prescription.prescriptionId,
        patientId: consultation.patient_id,
        status: "issued",
        metadata: {
          consultationId: consultation.id,
          queueId: consultation.queue_id ?? null,
          completed: true,
        },
      });
    }

    try {
      if (consultation.queue_id) {
        broadcastQueueUpdate(consultation.doctor_id, {
          queueId: Number(consultation.queue_id),
          sessionId: queueContext.schedule_id,
          patientId: consultation.patient_id,
          type: "CONSULTATION_COMPLETED",
          triggeredBy: "doctor",
        });
      }
    } catch (error) {
      console.error("Consultation completed socket emit error:", error);
    }

    try {
      if (consultation.queue_id) {
        const nextWaitingResult = await pool.query<{ token_number: number | null }>(
          `
          SELECT token_number
          FROM queue_patients
          WHERE queue_id = $1
            AND status = 'WAITING'
          ORDER BY token_number ASC
          LIMIT 1
          `,
          [consultation.queue_id]
        );
        const nextPatientToken = Number(nextWaitingResult.rows[0]?.token_number ?? null);
        if (nextPatientToken) {
          const nearTokenLimit = Number(nextPatientToken) + 2;
          const nearResult = await pool.query<{ expo_push_token: string | null }>(
            `
            SELECT pp.expo_push_token
            FROM queue_patients qp
            JOIN patient_profiles pp ON pp.user_id = qp.patient_id
            WHERE qp.queue_id = $1
              AND qp.status = 'WAITING'
              AND qp.token_number <= $2
            `,
            [consultation.queue_id, nearTokenLimit]
          );
          const nearTokens = filterExpoTokens(nearResult.rows.map((row) => row.expo_push_token));
          await sendExpoPush(
            nearTokens.map((tokenValue) => ({
              to: tokenValue,
              title: "Your Turn Soon",
              body: "Only a couple of patients left before your turn.",
              data: { queueId: consultation.queue_id },
            }))
          );
        }
      }
    } catch (error) {
      console.error("Near turn push error:", error);
    }

    if (prescription) {
      try {
        if (consultation.patient_id) {
          io.to(`patient_${consultation.patient_id}`).emit("prescription:ready", {
            patientId: consultation.patient_id,
            prescriptionId: prescription.prescriptionId,
          });
        }
      } catch (error) {
        console.error("Prescription socket emit error:", error);
      }

      try {
        const tokenResult = await pool.query<{ expo_push_token: string | null }>(
          `SELECT expo_push_token FROM patient_profiles WHERE user_id = $1`,
          [consultation.patient_id]
        );
        const tokens = filterExpoTokens(tokenResult.rows.map((row) => row.expo_push_token));
        await sendExpoPush(
          tokens.map((tokenValue) => ({
            to: tokenValue,
            title: "Prescription Ready",
            body: "A new prescription is available in your app.",
            data: { prescriptionId: prescription.prescriptionId },
          }))
        );
      } catch (error) {
        console.error("Prescription push error:", error);
      }
    }

    return {
      success: true,
      message: prescription
        ? "Consultation completed and prescription is ready."
        : "Consultation completed without a prescription.",
      consultationId: consultation.id,
      prescriptionId: prescription?.prescriptionId ?? null,
      qr: prescription?.qrImage ?? null,
      qrData: prescription?.qrData ?? null,
      token: prescription?.qrToken ?? null,
    };
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
};
