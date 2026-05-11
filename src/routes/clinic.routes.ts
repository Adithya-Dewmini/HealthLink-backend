import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  getClinicDetails,
  getClinicDoctorSchedule,
  getClinics,
  getClinicDoctors,
} from "../controllers/patientClinic.controller";

const router = express.Router();

router.use(authenticateToken);
router.get("/", getClinics);
router.get("/:clinicId", getClinicDetails);
router.get("/:clinicId/doctors", getClinicDoctors);
router.get("/:clinicId/doctors/:doctorId/schedule", getClinicDoctorSchedule);

export default router;
