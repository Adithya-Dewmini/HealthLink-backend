import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  checkActiveUserInCenter,
  requireMedicalCenterAdmin,
} from "../middleware/medicalCenterScope";
import { updateDoctorClinicController } from "../controllers/doctorClinicAdmin.controller";

const router = express.Router();

router.use(authenticateToken, requireMedicalCenterAdmin, checkActiveUserInCenter);
router.patch("/:id", updateDoctorClinicController);

export default router;
