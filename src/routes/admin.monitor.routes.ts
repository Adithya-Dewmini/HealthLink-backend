import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import {
  getAdminMonitorBookingsController,
  getAdminMonitorPrescriptionsController,
  listAdminMonitorQueuesController,
  listAdminMonitorSessionsController,
} from "../controllers/admin.monitor.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));
router.get("/monitor/queues", listAdminMonitorQueuesController);
router.get("/monitor/sessions", listAdminMonitorSessionsController);
router.get("/monitor/bookings", getAdminMonitorBookingsController);
router.get("/monitor/prescriptions", getAdminMonitorPrescriptionsController);

export default router;
