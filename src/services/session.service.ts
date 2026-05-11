import pool from "../config/db";
import { createCenterSchedule } from "./schedule.service";
import {
  computeClinicSessionStatus,
  getMonthDateRange,
  parseSessionTimeToMinutes,
} from "./sessionDomain.service";

type AppError = Error & { statusCode?: number };

type DoctorRow = { id: number };
type SessionRow = {
  id: number;
  date: string;
  start_time: string;
  end_time: string;
  slot_duration: number;
  max_patients: number;
  is_active: boolean;
  status: string | null;
  clinic_id: string;
  clinic_name: string;
  patient_count: number;
};

export type CreateDoctorSessionInput = {
  centerId: string;
  doctorId: number;
  date: string;
  startTime: string;
  endTime: string;
  maxPatients: number;
  createdByUserId: number;
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
};

const normalizeTime = (value: unknown) => String(value || "").trim().slice(0, 5);

const parseTimeToMinutes = (value: string) => {
  const parsed = parseSessionTimeToMinutes(value);
  if (parsed == null) {
    throw createStatusError("Time must be in HH:MM format", 400);
  }
  return parsed;
};

const getDoctorProfileId = async (doctorUserId: number) => {
  const result = await pool.query<DoctorRow>(
    `
      SELECT id
      FROM doctors
      WHERE user_id = $1
      LIMIT 1
    `,
    [doctorUserId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Doctor profile not found", 404);
  }

  return result.rows[0].id;
};

const deriveSlotDuration = (startTime: string, endTime: string, maxPatients: number) => {
  const durationMinutes = parseTimeToMinutes(endTime) - parseTimeToMinutes(startTime);
  if (durationMinutes <= 0) {
    throw createStatusError("endTime must be later than startTime", 400);
  }

  if (!Number.isInteger(maxPatients) || maxPatients <= 0) {
    throw createStatusError("maxPatients must be greater than 0", 400);
  }

  const slotDuration = Math.max(1, Math.floor(durationMinutes / maxPatients));
  if (slotDuration <= 0) {
    throw createStatusError("Unable to derive slot duration for this session", 400);
  }

  return slotDuration;
};

export const createClinicSession = async (input: CreateDoctorSessionInput) => {
  const slotDuration = deriveSlotDuration(input.startTime, input.endTime, input.maxPatients);

  const result = await createCenterSchedule({
    medicalCenterId: input.centerId,
    doctorUserId: input.doctorId,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    maxPatients: input.maxPatients,
    slotDuration,
    createdByUserId: input.createdByUserId,
  });

  await pool.query(
    `
      UPDATE medical_center_doctor_schedule
      SET status = $1
      WHERE id = $2
    `,
    [computeClinicSessionStatus(input.date, input.startTime, input.endTime, true), result.schedule.id]
  );

  return {
    message: result.message,
    session: {
      ...result.schedule,
      status: computeClinicSessionStatus(input.date, input.startTime, input.endTime, true),
    },
  };
};

export const getDoctorMonthlySchedule = async (doctorUserId: number, month: string) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || "").trim())) {
    throw createStatusError("month must be in YYYY-MM format", 400);
  }

  const { fromDate, toDate } = getMonthDateRange(month);
  const doctorProfileId = await getDoctorProfileId(doctorUserId);

  const result = await pool.query<SessionRow>(
    `
      SELECT
        s.id,
        s.date::text AS date,
        s.start_time::text AS start_time,
        s.end_time::text AS end_time,
        s.slot_duration,
        s.max_patients,
        s.is_active,
        s.status,
        s.medical_center_id AS clinic_id,
        mc.name AS clinic_name,
        COUNT(b.id)::int AS patient_count
      FROM medical_center_doctor_schedule s
      JOIN medical_centers mc ON mc.id = s.medical_center_id
      LEFT JOIN bookings b
        ON b.doctor_id = s.doctor_profile_id
       AND b.date = s.date
       AND b.time >= s.start_time
       AND b.time < s.end_time
       AND COALESCE(UPPER(b.status), '') NOT IN ('CANCELLED', 'MISSED')
      WHERE s.doctor_user_id = $1
        AND s.doctor_profile_id = $2
        AND s.date BETWEEN $3::date AND $4::date
        AND s.is_active = TRUE
      GROUP BY s.id, mc.name
      ORDER BY s.date ASC, s.start_time ASC
    `,
    [doctorUserId, doctorProfileId, fromDate, toDate]
  );

  const grouped = result.rows.reduce<Array<{ date: string; sessions: Array<Record<string, unknown>> }>>(
    (accumulator, row) => {
      const dateKey = row.date;
      const existing = accumulator.find((item) => item.date === dateKey);
      const session = {
        id: row.id,
        clinicId: row.clinic_id,
        clinicName: row.clinic_name,
        startTime: normalizeTime(row.start_time),
        endTime: normalizeTime(row.end_time),
        slotDuration: row.slot_duration,
        patientsCount: Number(row.patient_count || 0),
        maxPatients: row.max_patients,
        status: computeClinicSessionStatus(row.date, row.start_time, row.end_time, row.is_active),
      };

      if (existing) {
        existing.sessions.push(session);
        return accumulator;
      }

      accumulator.push({
        date: dateKey,
        sessions: [session],
      });
      return accumulator;
    },
    []
  );

  return grouped;
};
