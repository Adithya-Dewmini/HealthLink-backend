import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import {
  getAdminPharmacyActivityController,
  getAdminPharmacyDetailsController,
  listAdminPharmaciesController,
  updateAdminPharmacyStatusController,
} from "../controllers/admin.pharmacy.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));

router.get("/pharmacies", listAdminPharmaciesController);
router.get("/pharmacies/:id", getAdminPharmacyDetailsController);
router.get("/pharmacies/:id/activity", getAdminPharmacyActivityController);
router.patch("/pharmacies/:id/status", updateAdminPharmacyStatusController);

export default router;
