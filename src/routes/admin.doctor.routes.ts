import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import { listAdminDoctorsController } from "../controllers/admin.doctor.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));
router.get("/doctors", listAdminDoctorsController);

export default router;
