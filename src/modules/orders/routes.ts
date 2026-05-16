import express from "express";
import { authenticateToken } from "../../middleware/authenticateToken";
import {
  checkoutController,
  getMyOrdersController,
  getPatientOrderController,
  getPatientOrderTimelineController,
  cancelPatientOrderController,
} from "./controller";
import { getOrderInvoiceController } from "../../controllers/payment.controller";

const router = express.Router();

router.use(authenticateToken);
router.post("/checkout", checkoutController);
router.get("/my-orders", getMyOrdersController);
router.get("/:id/invoice", getOrderInvoiceController);
router.get("/:id/timeline", getPatientOrderTimelineController);
router.patch("/:id/cancel", cancelPatientOrderController);
router.get("/:id", getPatientOrderController);

export default router;
