import { Router } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import {
  getAdminUserDetailsController,
  listAdminUsersController,
  updateAdminUserRoleController,
  updateAdminUserStatusController,
} from "../controllers/admin.user.controller";

const router = Router();

router.use(authenticateToken, requireRole("admin"));

router.get("/users", listAdminUsersController);
router.get("/users/:id", getAdminUserDetailsController);
router.patch("/users/:id/status", updateAdminUserStatusController);
router.patch("/users/:id/role", updateAdminUserRoleController);

export default router;
