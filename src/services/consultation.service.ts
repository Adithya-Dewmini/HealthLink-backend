import type { PoolClient } from "pg";
import pool from "../config/db";
import { env } from "../config/env";
import { createAuditLogWithClient } from "./audit.service";
import { io } from "../server";
import QRCode from "qrcode";
import { filterExpoTokens, sendExpoPush } from "../utils/expoPush";
import { BOOKING_STATUS, updateNearestBookingStatus } from "../utils/bookingLifecycle";
import { SOCKET_EVENTS, logRealtimeEmit } from "./realtime.service";
import { createPrescriptionQrToken } from "./prescription.service";

const doctorRoom = (doctorId: number | string) => `doctor-${doctorId}`;
const receptionRoom = "reception";

type HttpError = Error & { statusCode?: number };
type Queryable = {
  query: <TRow = any>(text: string, params?: unknown[]) => Promise<{ rows: TRow[] }>;
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

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
    throw createStatusError("Doctor profile not found", 400);
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
    throw createStatusError("No active consultation patient found for this doctor and queue", 409);
  }

  return row;
};

export const getDoctorConsultationContext = async (queueId: number, doctorUserId: number) => {
  await ensureQueuePatientContext(pool, { queueId, doctorUserId });

  const currentPatientResult = await pool.query(
    `
    SELECT
      qp.patient_id,
      u.name,
      u.profile_image,
      CASE
        WHEN pp.dob IS NULL THEN NULL
        ELSE DATE_PART('year', AGE(pp.dob))::int
      END AS age,
      pp.gender,
      pp.blood_group,
      pp.conditions,
      pp.allergies
    FROM queue_patients qp
    JOIN users u ON qp.patient_id = u.id
    LEFT JOIN patient_profiles pp ON pp.user_id = u.id
    WHERE qp.queue_id = $1 AND qp.status = 'WITH_DOCTOR'
    LIMIT 1
    `,
    [queueId]
  );

  if (currentPatientResult.rows.length === 0) {
    throw createStatusError("No active patient for this queue", 404);
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
      throw createStatusError(validationError, 400);
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
    throw createStatusError(validationError, 400);
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
      throw createStatusError(validationError, 400);
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
    throw createStatusError("Consultation not found", 404);
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
    throw createStatusError("Consultation is already completed", 409);
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

    throw createStatusError("Not your consultation", 403);
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

export const completeConsultationRecord = async (consultationId: string, userId: number, medicines?: any[]) => {
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
      throw createStatusError("Consultation not found", 404);
    }

    let consultation = consultationResult.rows[0];
    consultation = await ensureDoctorOwnsConsultation(client, consultation, userId);

    if (String(consultation.status || "").toLowerCase() === "completed") {
      throw createStatusError("Consultation is already completed", 409);
    }

    if (!consultation.queue_id || !consultation.patient_id) {
      throw createStatusError("Consultation is not linked to an active queue entry", 409);
    }

    const queueContext = await ensureQueuePatientContext(client, {
      queueId: Number(consultation.queue_id),
      patientId: Number(consultation.patient_id),
      doctorUserId: userId,
    });

    if (queueContext.consultation_id && String(queueContext.consultation_id) !== String(consultation.id)) {
      throw createStatusError("Queue entry is linked to a different consultation", 409);
    }

    const medsFromBody = Array.isArray(medicines) ? medicines : null;
    const medsFromDb = Array.isArray(consultation.medicines) ? consultation.medicines : [];
    const meds = medsFromBody ?? medsFromDb;

    const validationError = validateMedicines(meds, true);
    if (validationError) {
      throw createStatusError(validationError, 400);
    }

    if (!Array.isArray(meds) || meds.length === 0) {
      throw createStatusError("Add at least one medicine before completing this consultation", 400);
    }

    const conflictList = await findMedicineConflicts(
      meds.map((med: any) => normalizeMedName(med?.name ?? med?.medicine_name))
    );
    if (conflictList.length > 0) {
      throw Object.assign(createStatusError("Medicine conflict detected", 400), {
        conflicts: conflictList,
      });
    }

    const existingPrescription = await client.query<{ id: number }>(
      `
      SELECT id
      FROM prescriptions
      WHERE consultation_id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [consultation.id]
    );

    if (existingPrescription.rows[0]?.id) {
      throw createStatusError("Prescription already issued for this consultation", 409);
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

    const prescriptionResult = await client.query<{ id: number }>(
      `
      INSERT INTO prescriptions (consultation_id, qr_code, medical_center_id)
      VALUES ($1, $2, $3)
      RETURNING id
      `,
      [consultation.id, "", consultation.medical_center_id ?? null]
    );

    const prescriptionId = prescriptionResult.rows[0].id;
    const token = createPrescriptionQrToken({
      prescriptionId,
      consultationId: consultation.id,
      patientId: consultation.patient_id,
      doctorId: consultation.doctor_id,
      medicalCenterId: consultation.medical_center_id ?? null,
    });
    const qrData = `https://healthlink.app/prescription/${token}`;
    const qrImage = await QRCode.toDataURL(qrData);

    await client.query(`UPDATE prescriptions SET qr_code = $1 WHERE id = $2`, [token, prescriptionId]);

    if (Array.isArray(meds)) {
      await insertPrescriptionItems(client, prescriptionId, meds);
    }

    await createAuditLogWithClient(client, {
      actorUserId: userId,
      actorRole: "doctor",
      userId,
      action: "prescription_created",
      entityType: "prescription",
      entityId: prescriptionId,
      metadata: {
        consultationId: consultation.id,
        patientId: consultation.patient_id,
        queueId: consultation.queue_id ?? null,
        medicineCount: Array.isArray(meds) ? meds.length : 0,
      },
    });

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

    try {
      if (consultation.patient_id) {
        io.to(`patient_${consultation.patient_id}`).emit("prescription:ready", {
          patientId: consultation.patient_id,
          prescriptionId,
        });
      }
    } catch (error) {
      console.error("Prescription socket emit error:", error);
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
        if (!nextPatientToken) {
          return {
            success: true,
            prescriptionId,
            qr: qrImage,
            qrData,
            token,
          };
        }

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
    } catch (error) {
      console.error("Near turn push error:", error);
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
          data: { prescriptionId },
        }))
      );
    } catch (error) {
      console.error("Prescription push error:", error);
    }

    return {
      success: true,
      prescriptionId,
      qr: qrImage,
      qrData,
      token,
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
