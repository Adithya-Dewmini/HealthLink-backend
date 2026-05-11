import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import { listAdminMedicalCentersController } from "../controllers/admin.medicalCenter.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));
router.get("/medical-centers", listAdminMedicalCentersController);

export default router;
