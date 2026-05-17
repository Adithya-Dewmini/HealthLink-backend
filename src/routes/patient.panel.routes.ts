import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { getPatientActiveQueueController } from "../controllers/patientPanel.controller";

const router = Router();

router.use(authenticateToken);
router.get("/queue/active", getPatientActiveQueueController);

export default router;
