import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import {
  createAdminUserController,
  listAdminUsersController,
} from "../controllers/admin.user.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));
router.get("/users", listAdminUsersController);
router.post("/users/admin", createAdminUserController);

export default router;
