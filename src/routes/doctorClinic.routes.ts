import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  acceptDoctorClinicInviteController,
  getDoctorClinicsController,
  rejectDoctorClinicInviteController,
} from "../controllers/doctorAssociation.controller";

const router = express.Router();

router.use(authenticateToken);

router.get("/my-clinics", getDoctorClinicsController);
router.post("/my-clinics/:id/accept", acceptDoctorClinicInviteController);
router.post("/my-clinics/:id/reject", rejectDoctorClinicInviteController);

export default router;
