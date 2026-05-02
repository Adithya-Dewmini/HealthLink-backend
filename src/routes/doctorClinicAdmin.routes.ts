import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  checkActiveUserInCenter,
  requireMedicalCenterAdmin,
} from "../middleware/medicalCenterScope";
import { updateDoctorClinicSpecialtyController } from "../controllers/medicalCenterDoctorAssignment.controller";

const router = express.Router();

router.use(authenticateToken, requireMedicalCenterAdmin, checkActiveUserInCenter);

router.patch("/:id", updateDoctorClinicSpecialtyController);

export default router;
