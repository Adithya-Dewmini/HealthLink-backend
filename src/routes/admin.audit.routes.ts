import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import {
  getAdminAuditLogDetailController,
  listAdminAuditLogsController,
} from "../controllers/admin.audit.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));
router.get("/audit-logs", listAdminAuditLogsController);
router.get("/audit-logs/:id", getAdminAuditLogDetailController);

export default router;
