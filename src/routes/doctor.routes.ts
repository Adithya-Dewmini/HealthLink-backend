import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  validateAcceptDoctorInviteBody,
  validateDoctorJoinRequestBody,
} from "../middleware/doctorAssignment.validation";
import {
  createAvailability,
  editAvailability,
  getDailyReport,
  getDashboard,
  getAvailability,
  getQueueDashboard,
  getWorkingDays,
  removeAvailability,
  saveWorkingDays,
} from "../controllers/doctor.controller";
import {
  getDoctorMeController,
  updateDoctorMeController,
} from "../controllers/doctorSelfProfile.controller";
import {
  acceptDoctorInviteController as acceptDoctorInviteActionController,
  requestToJoinMedicalCenterController as requestToJoinCenterActionController,
} from "../controllers/doctorAssociation.controller";
import { getDoctorScheduleOverviewController } from "../controllers/doctorSchedule.controller";
import {
  createDoctorExternalSessionController,
  deleteDoctorExternalSessionController,
  listDoctorExternalSessionsController,
} from "../controllers/doctorExternalSession.controller";
import { getDoctorRoutineController } from "../controllers/doctorRoutine.controller";
import {
  addPatientToQueue,
  endQueue,
  moveToNextPatient,
  pauseQueue,
  resumeQueue,
  skipPatient,
  startQueue,
} from "../controllers/doctorQueue.controller";
import {
  getDoctorPrescriptionDetailController,
  listDoctorPrescriptionsController,
} from "../controllers/doctorPrescription.controller";

const router = express.Router();

router.post(
  "/accept-invite",
  authenticateToken,
  validateAcceptDoctorInviteBody,
  acceptDoctorInviteActionController
);
router.post(
  "/request-join",
  authenticateToken,
  validateDoctorJoinRequestBody,
  requestToJoinCenterActionController
);

router.get("/me", authenticateToken, getDoctorMeController);
router.put("/me", authenticateToken, updateDoctorMeController);

router.post("/availability", authenticateToken, createAvailability);
router.get("/availability", authenticateToken, getAvailability);
router.post("/working-days", authenticateToken, saveWorkingDays);
router.get("/working-days", authenticateToken, getWorkingDays);
router.delete("/availability/:id", authenticateToken, removeAvailability);
router.put("/availability/:id", authenticateToken, editAvailability);
router.get("/schedule-overview", authenticateToken, getDoctorScheduleOverviewController);
router.get("/routines", authenticateToken, getDoctorRoutineController);
router.get("/external-sessions", authenticateToken, listDoctorExternalSessionsController);
router.post("/external-sessions", authenticateToken, createDoctorExternalSessionController);
router.delete(
  "/external-sessions/:externalSessionId",
  authenticateToken,
  deleteDoctorExternalSessionController
);
router.get("/prescriptions", authenticateToken, listDoctorPrescriptionsController);
router.get(
  "/prescriptions/:prescriptionId",
  authenticateToken,
  getDoctorPrescriptionDetailController
);
router.get("/dashboard", authenticateToken, getDashboard);

router.post("/queue/start", authenticateToken, startQueue);
router.post("/queue/pause", authenticateToken, pauseQueue);
router.post("/queue/resume", authenticateToken, resumeQueue);
router.post("/queue/add-patient", authenticateToken, addPatientToQueue);
router.post("/queue/next", authenticateToken, moveToNextPatient);
router.post("/queue/skip", authenticateToken, skipPatient);
router.post("/queue/end", authenticateToken, endQueue);
router.get("/queue/dashboard", authenticateToken, getQueueDashboard);
router.get("/reports/daily", authenticateToken, getDailyReport);

export default router;
