import { io } from "../server";

export const clinicPublicRoom = (clinicId: string) => `clinic_public_${clinicId}`;

export const emitClinicPublicScheduleUpdate = (payload: {
  clinicId: string;
  doctorId?: number | null;
  scheduleId?: number | null;
  type: string;
}) => {
  io.to(clinicPublicRoom(payload.clinicId)).emit("clinic:schedule-update", {
    clinicId: payload.clinicId,
    doctorId: payload.doctorId ?? null,
    scheduleId: payload.scheduleId ?? null,
    type: payload.type,
    emittedAt: new Date().toISOString(),
  });
};

export const emitClinicPublicQueueUpdate = (payload: {
  clinicId: string;
  doctorId?: number | string | null;
  queueId?: number | null;
  sessionId?: number | null;
  type: string;
}) => {
  io.to(clinicPublicRoom(payload.clinicId)).emit("clinic:queue-update", {
    clinicId: payload.clinicId,
    doctorId: payload.doctorId ?? null,
    queueId: payload.queueId ?? null,
    sessionId: payload.sessionId ?? null,
    type: payload.type,
    emittedAt: new Date().toISOString(),
  });
};
