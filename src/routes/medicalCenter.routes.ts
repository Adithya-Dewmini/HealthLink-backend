import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  checkActiveUserInCenter,
  requireMedicalCenterAdmin,
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
  updateDoctorRelationshipStatusController,
} from "../controllers/medicalCenterDoctorAssignment.controller";
import {
  createMedicalCenterScheduleController,
  disableMedicalCenterScheduleController,
  listMedicalCenterSchedulesController,
  previewMedicalCenterScheduleController,
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

router.use(authenticateToken, requireMedicalCenterAdmin, checkActiveUserInCenter);

router.get("/dashboard", getDashboard);

router.get("/doctors", listMedicalCenterDoctorAssignmentsController);
router.get("/doctors/requests", listDoctorJoinRequestsController);
router.post("/doctors/invite", validateInviteDoctorBody, inviteDoctorToMedicalCenterController);
router.post("/doctors/invites/:id/resend", resendDoctorInviteController);
router.patch(
  "/doctors/requests/:id",
  validateDoctorRequestActionBody,
  reviewDoctorJoinRequestController
);
router.patch(
  "/doctors/:id/status",
  validateDoctorRelationshipStatusBody,
  updateDoctorRelationshipStatusController
);
router.delete("/doctors/:id", removeDoctorFromMedicalCenterController);

router.get("/schedules", listMedicalCenterSchedulesController);
router.post("/schedules/preview", validateCreateScheduleBody, previewMedicalCenterScheduleController);
router.post("/schedules", validateCreateScheduleBody, createMedicalCenterScheduleController);
router.patch("/schedules/:id", validateUpdateScheduleBody, updateMedicalCenterScheduleController);
router.delete("/schedules/:id", disableMedicalCenterScheduleController);

router.get("/receptionists", listReceptionists);
router.post("/receptionists", createReceptionist);
router.post("/receptionists/:id/resend", resendReceptionistInviteController);
router.patch("/receptionists/:id/status", updateReceptionistStatusController);
router.get("/receptionists/:id/permissions", getReceptionistPermissionsController);
router.patch("/receptionists/:id/permissions", updateReceptionistPermissionsController);
router.delete("/receptionists/:id", deleteReceptionistController);

router.get("/queues", getQueues);
router.get("/appointments", getAppointments);

export default router;
