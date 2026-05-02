import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import { createAdminManagedUserController } from "../controllers/admin.user.management.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));

router.post("/users/admin", createAdminManagedUserController);

export default router;
