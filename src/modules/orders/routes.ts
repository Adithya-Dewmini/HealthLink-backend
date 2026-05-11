import express from "express";
import { authenticateToken } from "../../middleware/authenticateToken";
import {
  checkoutController,
  getMyOrdersController,
  getPatientOrderController,
  getPatientOrderTimelineController,
} from "./controller";

const router = express.Router();

router.use(authenticateToken);
router.post("/checkout", checkoutController);
router.get("/my-orders", getMyOrdersController);
router.get("/:id/timeline", getPatientOrderTimelineController);
router.get("/:id", getPatientOrderController);

export default router;
