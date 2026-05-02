import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  checkActiveUserInCenter,
  requireMedicalCenterAdmin,
  requireOperationalMedicalCenter,
} from "../middleware/medicalCenterScope";
import {
  createMedicalCenterRoutineController,
  deleteMedicalCenterRoutineController,
  generateMedicalCenterRoutineSessionsController,
  listMedicalCenterRoutinesController,
  updateMedicalCenterRoutineController,
} from "../controllers/medicalCenterRoutine.controller";

const router = express.Router();

router.use(authenticateToken, requireMedicalCenterAdmin, checkActiveUserInCenter);

router.get("/", listMedicalCenterRoutinesController);
router.post("/", requireOperationalMedicalCenter, createMedicalCenterRoutineController);
router.post("/generate", requireOperationalMedicalCenter, generateMedicalCenterRoutineSessionsController);
router.put("/:id", requireOperationalMedicalCenter, updateMedicalCenterRoutineController);
router.delete("/:id", requireOperationalMedicalCenter, deleteMedicalCenterRoutineController);

export default router;
