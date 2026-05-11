import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import { listAdminUsersController } from "../controllers/admin.user.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));
router.get("/users", listAdminUsersController);

export default router;
