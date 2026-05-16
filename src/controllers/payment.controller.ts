import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { formatApiError } from "../middleware/errorHandler";
import {
  createCheckoutSession,
  getHostedCheckoutHtml,
  getOrderInvoice,
  getPaymentStatus,
  updatePaymentFromGatewayNotification,
} from "../services/payment.service";
import { getOrderSummaryById } from "../modules/orders/service";
import {
  emitInvoiceGenerated,
  emitOrderUpdated,
  emitPaymentUpdated,
} from "../services/realtime.service";
import {
  createNotificationAndPush,
  getPharmacyMemberUserIds,
} from "../services/notification.service";

const parseOrderId = (value: unknown, label = "order id") => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`Valid ${label} is required`) as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  return parsed;
};

const requireAuthenticatedUser = (req: AuthenticatedRequest) => {
  const userId = Number(req.user?.id ?? 0);
  const role = String(req.user?.role || "").toLowerCase();

  if (!userId) {
    const error = new Error("Unauthorized") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }

  return { userId, role };
};

const requirePatientUser = (req: AuthenticatedRequest) => {
  const actor = requireAuthenticatedUser(req);
  if (actor.role !== "patient" && actor.role !== "user") {
    const error = new Error("Only patients can access payments") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
  return actor;
};

const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
  console.error(fallbackMessage, error);
  const formatted = formatApiError(
    error instanceof Error ? error : Object.assign(new Error(fallbackMessage), { statusCode: 500 })
  );
  return res.status(formatted.statusCode).json(formatted.body);
};

const notifyPaymentOutcome = async (input: {
  orderId: number;
  patientId: number;
  pharmacyId: number;
  paymentStatus: string;
  invoiceNo?: string | null;
}) => {
  if (input.paymentStatus === "paid") {
    const pharmacyUserIds = await getPharmacyMemberUserIds(input.pharmacyId);
    await Promise.all([
      ...pharmacyUserIds.map((userId) =>
        createNotificationAndPush({
          userId,
          title: "Order payment received",
          body: `Order #${input.orderId} has been paid and is ready for pharmacist processing.`,
          type: "payment_received",
          metadata: {
            orderId: input.orderId,
            pharmacyId: input.pharmacyId,
            patientId: input.patientId,
            invoiceNo: input.invoiceNo ?? null,
          },
        })
      ),
      createNotificationAndPush({
        userId: input.patientId,
        title: "Payment successful",
        body: input.invoiceNo
          ? `Payment for order #${input.orderId} is confirmed. Invoice ${input.invoiceNo} is ready.`
          : `Payment for order #${input.orderId} is confirmed.`,
        type: "payment_successful",
        metadata: {
          orderId: input.orderId,
          pharmacyId: input.pharmacyId,
          invoiceNo: input.invoiceNo ?? null,
        },
      }),
    ]);
    return;
  }

  if (["failed", "cancelled", "refunded"].includes(input.paymentStatus)) {
    const titleByStatus: Record<string, string> = {
      failed: "Payment failed",
      cancelled: "Payment cancelled",
      refunded: "Payment refunded",
    };

    await createNotificationAndPush({
      userId: input.patientId,
      title: titleByStatus[input.paymentStatus] || "Payment update",
      body: `Payment for order #${input.orderId} is now marked as ${input.paymentStatus}.`,
      type: "payment_update",
      metadata: {
        orderId: input.orderId,
        pharmacyId: input.pharmacyId,
        paymentStatus: input.paymentStatus,
      },
    });
  }
};

export const createPharmacyOrderCheckoutController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const actor = requirePatientUser(req);
    const orderId = parseOrderId(req.params.orderId);
    const session = await createCheckoutSession(orderId, actor.userId);

    return res.status(200).json({
      message: "Checkout session created",
      orderId: session.orderId,
      paymentId: session.paymentId,
      gateway: session.gateway,
      checkout_url: session.checkoutUrl,
      hosted_url: session.hostedUrl,
      hosted_token: session.hostedToken,
      fields: session.fields,
    });
  } catch (error) {
    return handleError(res, error, "Failed to create payment checkout session");
  }
};

export const getPharmacyOrderPaymentStatusController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const actor = requireAuthenticatedUser(req);
    const orderId = parseOrderId(req.params.orderId);
    const status = await getPaymentStatus(orderId, actor);
    return res.status(200).json(status);
  } catch (error) {
    return handleError(res, error, "Failed to load payment status");
  }
};

export const getOrderInvoiceController = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const actor = requireAuthenticatedUser(req);
    const orderId = parseOrderId(req.params.id ?? req.params.orderId);
    const invoice = await getOrderInvoice(orderId, actor);
    return res.status(200).json(invoice);
  } catch (error) {
    return handleError(res, error, "Failed to load invoice");
  }
};

export const getPayHereHostedCheckoutController = async (req: Request, res: Response) => {
  try {
    const paymentId = parseOrderId(req.params.paymentId, "payment id");
    const token = String(req.query.token || "").trim();
    if (!token) {
      const error = new Error("Hosted checkout token is required") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }

    const html = await getHostedCheckoutHtml(paymentId, token);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(html);
  } catch (error) {
    return handleError(res, error, "Failed to load hosted payment checkout");
  }
};

export const payHereNotifyController = async (req: Request, res: Response) => {
  try {
    const result = await updatePaymentFromGatewayNotification(req.body || {});

    if (result.processed && result.orderId && result.patientId && result.pharmacyId && result.paymentId) {
      const [order, paymentStatus] = await Promise.all([
        getOrderSummaryById(result.orderId),
        getPaymentStatus(result.orderId, { userId: result.patientId, role: "patient" }),
      ]);

      emitOrderUpdated(order);
      if (paymentStatus.payment) {
        emitPaymentUpdated({
          orderId: result.orderId,
          patientId: result.patientId,
          pharmacyId: result.pharmacyId,
          paymentId: result.paymentId,
          status: result.paymentStatus || paymentStatus.payment.status,
          payment: paymentStatus.payment,
          invoice: paymentStatus.invoice,
        });
      }
      if (paymentStatus.invoice) {
        emitInvoiceGenerated({
          orderId: result.orderId,
          patientId: result.patientId,
          pharmacyId: result.pharmacyId,
          invoiceId: paymentStatus.invoice.id,
          invoiceNo: paymentStatus.invoice.invoiceNo,
          invoice: paymentStatus.invoice,
        });
      }

      await notifyPaymentOutcome({
        orderId: result.orderId,
        patientId: result.patientId,
        pharmacyId: result.pharmacyId,
        paymentStatus: result.paymentStatus || paymentStatus.paymentStatus || "pending",
        invoiceNo: paymentStatus.invoice?.invoiceNo ?? result.invoiceNo ?? null,
      });
    }

    return res.status(200).send("OK");
  } catch (error) {
    return handleError(res, error, "Failed to process payment notification");
  }
};
