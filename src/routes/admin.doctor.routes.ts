import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import {
  getAdminDoctorDetailsController,
  listAdminDoctorAssociationsController,
  listAdminDoctorsController,
  listAdminDoctorSchedulesController,
  updateAdminDoctorStatusController,
  updateAdminDoctorVisibilityController,
} from "../controllers/admin.doctor.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));

router.get("/doctors", listAdminDoctorsController);
router.get("/doctors/:id", getAdminDoctorDetailsController);
router.get("/doctors/:id/associations", listAdminDoctorAssociationsController);
router.get("/doctors/:id/schedules", listAdminDoctorSchedulesController);
router.patch("/doctors/:id/status", updateAdminDoctorStatusController);
router.patch("/doctors/:id/visibility", updateAdminDoctorVisibilityController);

export default router;
