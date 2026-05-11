import express from "express";
import { authenticateToken } from "../../middleware/authenticateToken";
import {
  listNotificationsController,
  markNotificationReadController,
  registerPushTokenController,
} from "./controller";

const router = express.Router();

router.use(authenticateToken);
router.get("/", listNotificationsController);
router.post("/push-token", registerPushTokenController);
router.patch("/:id/read", markNotificationReadController);

export default router;
