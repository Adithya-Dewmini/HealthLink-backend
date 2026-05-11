import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  checkActiveUserInCenter,
  requireMedicalCenterAdmin,
} from "../middleware/medicalCenterScope";
import {
  getDoctorDirectoryProfileController,
  searchDoctorsDirectoryController,
} from "../controllers/doctorDirectory.controller";
import {
  removeDoctorFromMedicalCenterController,
  updateDoctorRelationshipStatusController,
} from "../controllers/medicalCenterDoctorAssignment.controller";
import {
  validateDoctorDirectoryIdParam,
  validateDoctorSearchQuery,
} from "../middleware/doctorDirectory.validation";

const router = express.Router();

router.use(authenticateToken, requireMedicalCenterAdmin, checkActiveUserInCenter);

router.get("/search", validateDoctorSearchQuery, searchDoctorsDirectoryController);
router.patch("/:id/status", updateDoctorRelationshipStatusController);
router.delete("/:id", removeDoctorFromMedicalCenterController);
router.get("/:id", validateDoctorDirectoryIdParam, getDoctorDirectoryProfileController);

export default router;
