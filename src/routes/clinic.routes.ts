import express from "express";
import authMiddleware from "../middleware/authMiddleware";
import {
  getClinicDoctorSchedule,
  getClinicDoctors,
  getClinics,
} from "../controllers/patientDoctor.controller";
import { listClinicDoctorsForAdminController } from "../controllers/medicalCenterDoctorAssignment.controller";

const router = express.Router();

router.get("/", authMiddleware, getClinics);
router.get("/:clinicId/doctors", authMiddleware, (req, res) => {
  const role = String((req as any).user?.role || "").toLowerCase();
  if (role === "medical_center_admin") {
    return (listClinicDoctorsForAdminController as any)(req, res);
  }
  return getClinicDoctors(req, res);
});
router.get("/:clinicId/doctors/:doctorId/schedule", authMiddleware, getClinicDoctorSchedule);

export default router;
