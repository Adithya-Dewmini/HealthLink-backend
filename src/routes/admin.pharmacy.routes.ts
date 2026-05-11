import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import { listAdminPharmaciesController } from "../controllers/admin.pharmacy.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));
router.get("/pharmacies", listAdminPharmaciesController);

export default router;
