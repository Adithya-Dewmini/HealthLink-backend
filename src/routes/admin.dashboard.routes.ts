import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import {
  getAdminActivitySummaryController,
  getAdminAlertsController,
  getAdminDashboardController,
} from "../controllers/admin.dashboard.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));

router.get("/dashboard", getAdminDashboardController);
router.get("/alerts", getAdminAlertsController);
router.get("/activity-summary", getAdminActivitySummaryController);

export default router;
