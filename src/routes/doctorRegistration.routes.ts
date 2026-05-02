import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import {
  getDoctorRegistrationProfileController,
  listPendingDoctorsController,
  registerDoctorController,
  verifyDoctorController,
} from "../controllers/doctorRegistration.controller";
import {
  doctorRegistrationUploadFields,
  handleDoctorRegistrationUpload,
} from "../middleware/upload";
import {
  validateDoctorRegistrationBody,
  validateDoctorVerificationBody,
} from "../middleware/doctorRegistration.validation";

const router = Router();
const adminRouter = Router();

router.post(
  "/register",
  handleDoctorRegistrationUpload(doctorRegistrationUploadFields),
  validateDoctorRegistrationBody,
  registerDoctorController
);

router.get("/registration/:id", authenticateToken, getDoctorRegistrationProfileController);

adminRouter.use(authenticateToken, requireRole("admin"));
adminRouter.get("/doctors/pending", listPendingDoctorsController);
adminRouter.patch("/doctors/:id/verify", validateDoctorVerificationBody, verifyDoctorController);

export { router as doctorRegistrationRoutes, adminRouter as adminDoctorRegistrationRoutes };
