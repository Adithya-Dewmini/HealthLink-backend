import type { PoolClient } from "pg";
import pool from "../config/db";
import { env } from "../config/env";
import { createAuditLogWithClient } from "./audit.service";
import { io } from "../server";
import QRCode from "qrcode";
import jwt from "jsonwebtoken";
import { filterExpoTokens, sendExpoPush } from "../utils/expoPush";
import { BOOKING_STATUS, updateNearestBookingStatus } from "../utils/bookingLifecycle";

const QR_SECRET = env.jwtSecret;
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
  payload: { queueId: number; type: string; triggeredBy?: string }
) => {
  const enrichedPayload = { ...payload, doctorId };
  io.to(doctorRoom(doctorId)).emit("queueUpdated", enrichedPayload);
  io.to(receptionRoom).emit("queueUpdated", enrichedPayload);
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

export const getDoctorConsultationContext = async (queueId: number) => {
  const currentPatientResult = await pool.query(
    `
    SELECT
      qp.patient_id,
      u.name,
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
      name: patientRow.name,
      age: patientRow.age,
      gender: patientRow.gender,
      bloodGroup: patientRow.blood_group,
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

  const doctorResult = await pool.query<{ id: number; medical_center_id: string | null }>(
    `SELECT id, medical_center_id FROM doctors WHERE user_id = $1`,
    [userId]
  );
  if (doctorResult.rows.length === 0) {
    throw createStatusError("Doctor profile not found", 400);
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
      doctorResult.rows[0].medical_center_id ?? null,
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
  consultationId: string;
  symptoms?: string | null;
  diagnosis?: string | null;
  notes?: string | null;
  medicines?: any[];
}) => {
  const { consultationId, symptoms, diagnosis, notes, medicines } = options;

  if (medicines !== undefined) {
    const validationError = validateMedicines(medicines, true);
    if (validationError) {
      throw createStatusError(validationError, 400);
    }
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

  if (result.rows.length === 0) {
    throw createStatusError("Consultation not found", 404);
  }

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

  try {
    await client.query("BEGIN");

    const consultationResult = await client.query(
      `
      UPDATE consultations
      SET status = 'completed', updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [consultationId]
    );

    if (consultationResult.rows.length === 0) {
      throw createStatusError("Consultation not found", 404);
    }

    let consultation = consultationResult.rows[0];
    consultation = await ensureDoctorOwnsConsultation(client, consultation, userId);

    const medsFromBody = Array.isArray(medicines) ? medicines : null;
    const medsFromDb = Array.isArray(consultation.medicines) ? consultation.medicines : [];
    const meds = medsFromBody ?? medsFromDb;

    const validationError = validateMedicines(meds, true);
    if (validationError) {
      throw createStatusError(validationError, 400);
    }

    const conflictList = await findMedicineConflicts(
      meds.map((med: any) => normalizeMedName(med?.name ?? med?.medicine_name))
    );
    if (conflictList.length > 0) {
      throw Object.assign(createStatusError("Medicine conflict detected", 400), {
        conflicts: conflictList,
      });
    }

    const prescriptionResult = await client.query<{ id: number }>(
      `
      INSERT INTO prescriptions (consultation_id, qr_code, medical_center_id)
      VALUES ($1, $2, $3)
      RETURNING id
      `,
      [consultation.id, "", consultation.medical_center_id ?? null]
    );

    const prescriptionId = prescriptionResult.rows[0].id;
    const token = jwt.sign(
      {
        prescriptionId,
        patientId: consultation.patient_id,
      },
      QR_SECRET,
      { expiresIn: "2h" }
    );
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

    if (consultation.queue_id && consultation.patient_id) {
      await client.query(
        `
        UPDATE queue_patients
        SET status = 'COMPLETED', completed_at = NOW(), consultation_id = $1
        WHERE queue_id = $2 AND patient_id = $3 AND status = 'WITH_DOCTOR'
        `,
        [consultation.id, consultation.queue_id, consultation.patient_id]
      );

      await updateNearestBookingStatus(client, {
        doctorId: Number(consultation.doctor_id),
        patientId: Number(consultation.patient_id),
        nextStatus: BOOKING_STATUS.COMPLETED,
        allowedCurrentStatuses: [BOOKING_STATUS.IN_PROGRESS],
        setEndedAt: true,
      });

      broadcastQueueUpdate(consultation.doctor_id, {
        queueId: consultation.queue_id,
        type: "CONSULTATION_COMPLETED",
        triggeredBy: "doctor",
      });
    }

    let nextPatientToken: number | null = null;
    const queueIdForNear = consultation.queue_id ?? null;

    if (consultation.queue_id) {
      const nextPatientResult = await client.query(
        `
        SELECT *
        FROM queue_patients
        WHERE queue_id = $1
          AND status = 'WAITING'
        ORDER BY token_number ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
        `,
        [consultation.queue_id]
      );

      if (nextPatientResult.rows.length > 0) {
        const nextPatient = nextPatientResult.rows[0];
        nextPatientToken = Number(nextPatient.token_number ?? null);

        await client.query(
          `
          UPDATE queue_patients
          SET status = 'WITH_DOCTOR', started_at = NOW()
          WHERE id = $1
          `,
          [nextPatient.id]
        );

        await updateNearestBookingStatus(client, {
          doctorId: Number(consultation.doctor_id),
          patientId: Number(nextPatient.patient_id),
          nextStatus: BOOKING_STATUS.IN_PROGRESS,
          allowedCurrentStatuses: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.BOOKED],
          setStartedAt: true,
        });

        const nextConsultationResult = await client.query<{ id: number }>(
          `
          INSERT INTO consultations
            (patient_id, doctor_id, queue_id, symptoms, diagnosis, notes, medicines, medical_center_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id
          `,
          [
            nextPatient.patient_id,
            consultation.doctor_id,
            consultation.queue_id,
            null,
            null,
            null,
            JSON.stringify([]),
            consultation.medical_center_id ?? null,
          ]
        );
        const nextConsultationId = nextConsultationResult.rows[0]?.id ?? null;
        if (nextConsultationId) {
          await client.query(
            `
            UPDATE queue_patients
            SET consultation_id = $1
            WHERE id = $2
            `,
            [nextConsultationId, nextPatient.id]
          );
        }

        broadcastQueueUpdate(consultation.doctor_id, {
          queueId: consultation.queue_id,
          type: "NEXT_PATIENT",
          triggeredBy: "doctor",
        });
      }
    }

    await client.query("COMMIT");

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
      if (queueIdForNear && nextPatientToken) {
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
          [queueIdForNear, nearTokenLimit]
        );
        const nearTokens = filterExpoTokens(nearResult.rows.map((row) => row.expo_push_token));
        await sendExpoPush(
          nearTokens.map((tokenValue) => ({
            to: tokenValue,
            title: "Your Turn Soon",
            body: "Only a couple of patients left before your turn.",
            data: { queueId: queueIdForNear },
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
  } finally {
    client.release();
  }
};
