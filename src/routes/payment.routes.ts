import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  createPharmacyOrderCheckoutController,
  getPayHereHostedCheckoutController,
  getPayHereRedirectStatusController,
  getPharmacyOrderPaymentStatusController,
  payHereNotifyController,
} from "../controllers/payment.controller";

const router = express.Router();

router.post("/payhere/notify", express.urlencoded({ extended: false }), payHereNotifyController);
router.get("/payhere/hosted/:paymentId", getPayHereHostedCheckoutController);
router.get("/payhere/redirect-status/:orderId", getPayHereRedirectStatusController);

router.use(authenticateToken);
router.post("/pharmacy-orders/:orderId/checkout", createPharmacyOrderCheckoutController);
router.get("/pharmacy-orders/:orderId/status", getPharmacyOrderPaymentStatusController);

export default router;
