import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  addReceptionQueueController,
  completeReceptionQueueController,
  createReceptionAppointmentController,
  getReceptionAppointmentsController,
  getReceptionDashboardController,
  getReceptionPatientsController,
  getReceptionPermissionsController,
  getReceptionQueueController,
  missReceptionQueueController,
  nextReceptionQueueController,
  registerReceptionPatientController,
  updateReceptionAppointmentController,
} from "../controllers/reception.controller";

const router = express.Router();

router.use(authenticateToken);

router.get("/permissions", getReceptionPermissionsController);
router.get("/dashboard", getReceptionDashboardController);
router.get("/queue", getReceptionQueueController);
router.post("/queue/add", addReceptionQueueController);
router.post("/queue/next", nextReceptionQueueController);
router.post("/queue/complete", completeReceptionQueueController);
router.post("/queue/miss", missReceptionQueueController);

router.post("/patient/register", registerReceptionPatientController);

router.get("/appointments", getReceptionAppointmentsController);
router.post("/appointments", createReceptionAppointmentController);
router.patch("/appointments/:id", updateReceptionAppointmentController);

router.get("/patients", getReceptionPatientsController);

export default router;
