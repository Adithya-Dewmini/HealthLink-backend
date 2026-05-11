import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  checkActiveUserInCenter,
  requireMedicalCenterAdmin,
} from "../middleware/medicalCenterScope";
import {
  createClinicSpecialtyController,
  deleteClinicSpecialtyController,
  listClinicSpecialtiesController,
  updateClinicSpecialtyController,
} from "../controllers/clinicSpecialty.controller";

const router = express.Router();

router.use(authenticateToken, requireMedicalCenterAdmin, checkActiveUserInCenter);
router.get("/", listClinicSpecialtiesController);
router.post("/", createClinicSpecialtyController);
router.put("/:id", updateClinicSpecialtyController);
router.delete("/:id", deleteClinicSpecialtyController);

export default router;
