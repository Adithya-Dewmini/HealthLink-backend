import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireVerifiedDoctor } from "../middleware/verifiedDoctor";
import {
  completeConsultation,
  createConsultation,
  getDoctorConsultation,
  getMedicines,
  issueConsultationPrescription,
  saveConsultationMedicines,
  updateConsultation,
} from "../controllers/consultation.controller";
import {
  dispense,
  getPrescription,
  verifyPrescription,
} from "../controllers/prescription.controller";

const router = express.Router();

router.get("/medicines", authenticateToken, getMedicines);

router.get("/doctor/consultation/:queueId", authenticateToken, requireVerifiedDoctor, getDoctorConsultation);

router.post("/consultations", authenticateToken, requireVerifiedDoctor, createConsultation);

router.post("/consultations/:id/medicines", authenticateToken, requireVerifiedDoctor, saveConsultationMedicines);

router.patch("/consultations/:id", authenticateToken, requireVerifiedDoctor, updateConsultation);

router.post(
  "/consultations/:id/issue-prescription",
  authenticateToken,
  requireVerifiedDoctor,
  issueConsultationPrescription
);

router.post("/consultations/:id/complete", authenticateToken, requireVerifiedDoctor, completeConsultation);

router.get("/prescriptions/verify/:token", authenticateToken, verifyPrescription);

router.get("/prescriptions/:id", authenticateToken, getPrescription);

router.post("/prescriptions/:id/dispense", authenticateToken, dispense);

export default router;
