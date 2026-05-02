import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import {
  addVerificationNoteController,
  approveVerificationController,
  getVerificationDetailController,
  listVerificationsController,
  rejectVerificationController,
} from "../controllers/admin.verification.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));

router.get("/verifications", listVerificationsController);
router.get("/verifications/:entityType/:entityId", getVerificationDetailController);
router.post("/verifications/:entityType/:entityId/approve", approveVerificationController);
router.post("/verifications/:entityType/:entityId/reject", rejectVerificationController);
router.post("/verifications/:entityType/:entityId/note", addVerificationNoteController);

export default router;
