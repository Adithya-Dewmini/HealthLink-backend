import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import {
  getAdminMedicalCenterActivityController,
  getAdminMedicalCenterDetailsController,
  listAdminMedicalCenterDoctorsController,
  listAdminMedicalCentersController,
  listAdminMedicalCenterSchedulesController,
  updateAdminMedicalCenterStatusController,
} from "../controllers/admin.medicalCenter.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));

router.get("/medical-centers", listAdminMedicalCentersController);
router.get("/medical-centers/:id", getAdminMedicalCenterDetailsController);
router.patch("/medical-centers/:id/status", updateAdminMedicalCenterStatusController);
router.get("/medical-centers/:id/doctors", listAdminMedicalCenterDoctorsController);
router.get("/medical-centers/:id/schedules", listAdminMedicalCenterSchedulesController);
router.get("/medical-centers/:id/activity", getAdminMedicalCenterActivityController);

export default router;
