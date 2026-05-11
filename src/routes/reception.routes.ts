import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireReceptionistPermission } from "../middleware/medicalCenterScope";
import {
  cancelReceptionVisitController,
  checkInReceptionAppointmentController,
  checkInReceptionVisitController,
  completeReceptionVisitController,
  createReceptionAppointmentController,
  createReceptionVisitController,
  createReceptionSessionDoctorManualSchedule,
  getReceptionDashboard,
  getReceptionAppointments,
  getReceptionPermissions,
  getReceptionQueueDetail,
  getReceptionQueue,
  getReceptionSessionDoctorAvailability,
  getReceptionSessionDoctorAvailabilityState,
  getReceptionSessionDoctorRoutines,
  getReceptionSessionDoctorSchedules,
  getReceptionSessionDoctors,
  updateReceptionSessionSchedule,
  getReceptionVisitDetail,
  getReceptionVisits,
  listReceptionPatients,
  deleteReceptionSessionSchedule,
  queueEnd,
  queuePause,
  queueCompletePatient,
  queueMissPatient,
  queueNextPatient,
  queueResume,
  queueStart,
  queueWalkIn,
  registerReceptionPatient,
  saveReceptionSessionDoctorRoutine,
  sendReceptionVisitToQueueController,
  markReceptionVisitMissedController,
  updateReceptionAppointmentController,
} from "../controllers/reception.controller";

const router = express.Router();

router.use(authenticateToken);
router.get("/permissions", getReceptionPermissions);
router.get("/dashboard", getReceptionDashboard);
router.get("/queue", requireReceptionistPermission("queue_access"), getReceptionQueue);
router.get("/queue/detail", requireReceptionistPermission("queue_access"), getReceptionQueueDetail);
router.get("/queues", requireReceptionistPermission("queue_access"), getReceptionQueue);
router.get("/queues/:queueId", requireReceptionistPermission("queue_access"), getReceptionQueueDetail);
router.get(
  "/queues/session/:sessionId",
  requireReceptionistPermission("queue_access"),
  getReceptionQueueDetail
);
router.post("/queue/start", requireReceptionistPermission("queue_access"), queueStart);
router.post("/queue/pause", requireReceptionistPermission("queue_access"), queuePause);
router.post("/queue/resume", requireReceptionistPermission("queue_access"), queueResume);
router.post("/queue/end", requireReceptionistPermission("queue_access"), queueEnd);
router.post("/queue/next", requireReceptionistPermission("queue_access"), queueNextPatient);
router.post("/queue/complete", requireReceptionistPermission("queue_access"), queueCompletePatient);
router.post("/queue/miss", requireReceptionistPermission("queue_access"), queueMissPatient);
router.post("/queue/walkin", requireReceptionistPermission("queue_access"), queueWalkIn);
router.post("/queues/:queueId/start", requireReceptionistPermission("queue_access"), queueStart);
router.post("/queues/:queueId/pause", requireReceptionistPermission("queue_access"), queuePause);
router.post("/queues/:queueId/resume", requireReceptionistPermission("queue_access"), queueResume);
router.post("/queues/:queueId/end", requireReceptionistPermission("queue_access"), queueEnd);
router.post("/queues/:queueId/next", requireReceptionistPermission("queue_access"), queueNextPatient);
router.post(
  "/queues/:queueId/complete",
  requireReceptionistPermission("queue_access"),
  queueCompletePatient
);
router.post("/queues/:queueId/miss", requireReceptionistPermission("queue_access"), queueMissPatient);
router.post("/queues/:queueId/walkin", requireReceptionistPermission("queue_access"), queueWalkIn);
router.get("/appointments", requireReceptionistPermission("appointments"), getReceptionAppointments);
router.post("/appointments", requireReceptionistPermission("appointments"), createReceptionAppointmentController);
router.post("/appointments/check-in", requireReceptionistPermission("check_in"), checkInReceptionAppointmentController);
router.patch(
  "/appointments/:appointmentId",
  requireReceptionistPermission("appointments"),
  updateReceptionAppointmentController
);
router.get("/visits", requireReceptionistPermission("appointments"), getReceptionVisits);
router.get("/visits/:id", requireReceptionistPermission("appointments"), getReceptionVisitDetail);
router.post("/visits", requireReceptionistPermission("appointments"), createReceptionVisitController);
router.post("/visits/:id/check-in", requireReceptionistPermission("check_in"), checkInReceptionVisitController);
router.post("/visits/:id/mark-missed", requireReceptionistPermission("appointments"), markReceptionVisitMissedController);
router.post("/visits/:id/cancel", requireReceptionistPermission("appointments"), cancelReceptionVisitController);
router.post("/visits/:id/send-to-queue", requireReceptionistPermission("queue_access"), sendReceptionVisitToQueueController);
router.post("/visits/:id/complete", requireReceptionistPermission("appointments"), completeReceptionVisitController);
router.get("/sessions/doctors", requireReceptionistPermission("schedule_management"), getReceptionSessionDoctors);
router.get(
  "/sessions/doctors/:doctorId/availability-state",
  requireReceptionistPermission("schedule_management"),
  getReceptionSessionDoctorAvailabilityState
);
router.get(
  "/sessions/doctors/:doctorId/availability",
  requireReceptionistPermission("schedule_management"),
  getReceptionSessionDoctorAvailability
);
router.get(
  "/sessions/doctors/:doctorId/schedules",
  requireReceptionistPermission("schedule_management"),
  getReceptionSessionDoctorSchedules
);
router.get(
  "/sessions/doctors/:doctorId/schedules/routine",
  requireReceptionistPermission("schedule_management"),
  getReceptionSessionDoctorRoutines
);
router.put(
  "/sessions/doctors/:doctorId/routine",
  requireReceptionistPermission("schedule_management"),
  saveReceptionSessionDoctorRoutine
);
router.post(
  "/sessions/doctors/:doctorId/manual",
  requireReceptionistPermission("schedule_management"),
  createReceptionSessionDoctorManualSchedule
);
router.patch(
  "/sessions/:scheduleId",
  requireReceptionistPermission("schedule_management"),
  updateReceptionSessionSchedule
);
router.delete(
  "/sessions/:scheduleId",
  requireReceptionistPermission("schedule_management"),
  deleteReceptionSessionSchedule
);
router.get("/patients", requireReceptionistPermission("check_in"), listReceptionPatients);
router.post("/patient/register", requireReceptionistPermission("check_in"), registerReceptionPatient);

export default router;
