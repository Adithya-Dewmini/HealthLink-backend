import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  checkActiveUserInCenter,
  requireMedicalCenterScope,
  requireMedicalCenterAdmin,
  requireReceptionistPermission,
} from "../middleware/medicalCenterScope";
import {
  validateDoctorRelationshipStatusBody,
  validateDoctorRequestActionBody,
  validateInviteDoctorBody,
} from "../middleware/doctorAssignment.validation";
import {
  validateCreateScheduleBody,
  validateUpdateScheduleBody,
} from "../middleware/schedule.validation";
import {
  inviteDoctorToMedicalCenterController,
  listDoctorJoinRequestsController,
  listMedicalCenterDoctorAssignmentsController,
  removeDoctorFromMedicalCenterController,
  resendDoctorInviteController,
  reviewDoctorJoinRequestController,
  updateDoctorRelationshipDisplayController,
  updateDoctorRelationshipStatusController,
} from "../controllers/medicalCenterDoctorAssignment.controller";
import {
  createMedicalCenterScheduleController,
  createMedicalCenterDoctorManualScheduleController,
  disableMedicalCenterScheduleController,
  getMedicalCenterDoctorAvailabilityStateController,
  disableMedicalCenterDoctorScheduleController,
  getMedicalCenterDoctorAvailabilityController,
  listMedicalCenterDoctorRoutinesController,
  listMedicalCenterDoctorSchedulesController,
  listMedicalCenterSchedulesController,
  previewMedicalCenterScheduleController,
  saveMedicalCenterDoctorRoutineController,
  updateMedicalCenterScheduleController,
} from "../controllers/medicalCenterSchedule.controller";
import {
  createReceptionist,
  deleteReceptionistController,
  getReceptionistPermissionsController,
  listReceptionists,
  resendReceptionistInviteController,
  updateReceptionistStatusController,
  updateReceptionistPermissionsController,
} from "../controllers/medicalCenterReceptionist.controller";
import {
  getAppointments,
  getDashboard,
  getQueues,
} from "../controllers/medicalCenter.controller";

const router = express.Router();

router.use(authenticateToken, requireMedicalCenterScope, checkActiveUserInCenter);

router.get("/dashboard", requireMedicalCenterAdmin, getDashboard);

router.get("/doctors", requireReceptionistPermission("schedule_management"), listMedicalCenterDoctorAssignmentsController);
router.get("/doctors/requests", requireMedicalCenterAdmin, listDoctorJoinRequestsController);
router.post("/doctors/invite", requireMedicalCenterAdmin, validateInviteDoctorBody, inviteDoctorToMedicalCenterController);
router.post("/doctors/invites/:id/resend", requireMedicalCenterAdmin, resendDoctorInviteController);
router.patch(
  "/doctors/requests/:id",
  requireMedicalCenterAdmin,
  validateDoctorRequestActionBody,
  reviewDoctorJoinRequestController
);
router.patch(
  "/doctors/:id/status",
  requireMedicalCenterAdmin,
  validateDoctorRelationshipStatusBody,
  updateDoctorRelationshipStatusController
);
router.get("/doctors/:doctorId/schedules", requireReceptionistPermission("schedule_management"), listMedicalCenterDoctorSchedulesController);
router.get("/doctors/:doctorId/schedules/routine", requireReceptionistPermission("schedule_management"), listMedicalCenterDoctorRoutinesController);
router.put("/doctors/:doctorId/schedules/routine", requireReceptionistPermission("schedule_management"), saveMedicalCenterDoctorRoutineController);
router.get("/doctors/:doctorId/availability-state", requireReceptionistPermission("schedule_management"), getMedicalCenterDoctorAvailabilityStateController);
router.get("/doctors/:doctorId/availability", requireReceptionistPermission("schedule_management"), getMedicalCenterDoctorAvailabilityController);
router.post(
  "/doctors/:doctorId/schedules/manual",
  requireReceptionistPermission("schedule_management"),
  validateCreateScheduleBody,
  createMedicalCenterDoctorManualScheduleController
);
router.delete(
  "/doctors/:doctorId/schedules/:scheduleId",
  requireReceptionistPermission("schedule_management"),
  disableMedicalCenterDoctorScheduleController
);
router.patch("/doctors/:id/pin", requireMedicalCenterAdmin, updateDoctorRelationshipDisplayController);
router.patch("/doctors/:id/hide", requireMedicalCenterAdmin, updateDoctorRelationshipDisplayController);
router.delete("/doctors/:id", requireMedicalCenterAdmin, removeDoctorFromMedicalCenterController);

router.get("/schedules", requireMedicalCenterAdmin, listMedicalCenterSchedulesController);
router.post("/schedules/preview", requireMedicalCenterAdmin, validateCreateScheduleBody, previewMedicalCenterScheduleController);
router.post("/schedules", requireMedicalCenterAdmin, validateCreateScheduleBody, createMedicalCenterScheduleController);
router.patch("/schedules/:id", requireMedicalCenterAdmin, validateUpdateScheduleBody, updateMedicalCenterScheduleController);
router.delete("/schedules/:id", requireMedicalCenterAdmin, disableMedicalCenterScheduleController);

router.get("/receptionists", requireMedicalCenterAdmin, listReceptionists);
router.post("/receptionists", requireMedicalCenterAdmin, createReceptionist);
router.post("/receptionists/:id/resend", requireMedicalCenterAdmin, resendReceptionistInviteController);
router.patch("/receptionists/:id/status", requireMedicalCenterAdmin, updateReceptionistStatusController);
router.get("/receptionists/:id/permissions", requireMedicalCenterAdmin, getReceptionistPermissionsController);
router.patch("/receptionists/:id/permissions", requireMedicalCenterAdmin, updateReceptionistPermissionsController);
router.delete("/receptionists/:id", requireMedicalCenterAdmin, deleteReceptionistController);

router.get("/queues", requireMedicalCenterAdmin, getQueues);
router.get("/appointments", requireMedicalCenterAdmin, getAppointments);

export default router;
