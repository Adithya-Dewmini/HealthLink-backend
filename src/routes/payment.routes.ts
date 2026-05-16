import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  createPharmacyOrderCheckoutController,
  getPayHereHostedCheckoutController,
  getPharmacyOrderPaymentStatusController,
  payHereNotifyController,
} from "../controllers/payment.controller";

const router = express.Router();

router.post("/payhere/notify", express.urlencoded({ extended: false }), payHereNotifyController);
router.get("/payhere/hosted/:paymentId", getPayHereHostedCheckoutController);

router.use(authenticateToken);
router.post("/pharmacy-orders/:orderId/checkout", createPharmacyOrderCheckoutController);
router.get("/pharmacy-orders/:orderId/status", getPharmacyOrderPaymentStatusController);

export default router;
