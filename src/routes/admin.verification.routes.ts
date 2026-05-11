import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import {
  approveVerificationController,
  addVerificationNoteController,
  getVerificationDetailController,
  listVerificationsController,
  rejectVerificationController,
  suspendVerificationController,
} from "../controllers/admin.verification.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));
router.get("/verifications", listVerificationsController);
router.get("/verifications/:type/:id", getVerificationDetailController);
router.post("/verifications/:type/:id/approve", approveVerificationController);
router.post("/verifications/:type/:id/reject", rejectVerificationController);
router.post("/verifications/:type/:id/suspend", suspendVerificationController);
router.post("/verifications/:type/:id/note", addVerificationNoteController);

export default router;
