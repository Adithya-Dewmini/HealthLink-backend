import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { formatApiError } from "../middleware/errorHandler";
import {
  createCheckoutSession,
  getHostedCheckoutHtml,
  getOrderInvoice,
  getPublicPaymentRedirectStatus,
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
import { HttpError } from "../modules/pharmacy/errors";

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

const mapCheckoutSessionErrorForClient = (error: unknown) => {
  const message = String((error as Error | undefined)?.message || "").toLowerCase();
  const statusCode = Number((error as { statusCode?: number } | undefined)?.statusCode || 0);

  if ([400, 401, 403, 409].includes(statusCode) && error instanceof Error) {
    return error;
  }

  if (
    statusCode === 503 ||
    message.includes("payment gateway is not configured") ||
    message.includes("payment gateway is not configured correctly")
  ) {
    return new HttpError(503, "Payment gateway is not configured correctly.");
  }

  return new HttpError(500, "Unable to complete checkout. Please try again.");
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
      payment_id: session.paymentId,
      order_id: session.gatewayOrderId,
      merchant_id: session.fields.merchant_id,
      return_url: session.fields.return_url,
      cancel_url: session.fields.cancel_url,
      notify_url: session.fields.notify_url,
      first_name: session.fields.first_name,
      last_name: session.fields.last_name,
      email: session.fields.email,
      phone: session.fields.phone,
      address: session.fields.address,
      city: session.fields.city,
      country: session.fields.country,
      items: session.fields.items,
      currency: session.fields.currency,
      amount: session.fields.amount,
      hash: session.fields.hash,
      custom_1: session.fields.custom_1,
      custom_2: session.fields.custom_2,
      sandbox: session.sandbox,
      mode: session.mode,
      checkout_url: session.checkoutUrl,
      hosted_url: session.hostedUrl,
      hosted_token: session.hostedToken,
      fields: session.fields,
    });
  } catch (error) {
    return handleError(
      res,
      mapCheckoutSessionErrorForClient(error),
      "Failed to create payment checkout session"
    );
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

export const getPayHereRedirectStatusController = async (req: Request, res: Response) => {
  try {
    const orderId = parseOrderId(req.params.orderId);
    const gatewayOrderId = String(req.query.gatewayOrderId || req.query.order_id || "").trim() || null;
    const paymentIdRaw = String(req.query.paymentId || req.query.payment_id || "").trim();
    const paymentId = paymentIdRaw ? parseOrderId(paymentIdRaw, "payment id") : null;

    const status = await getPublicPaymentRedirectStatus({
      orderId,
      gatewayOrderId,
      paymentId,
      source: "payhere_return_page",
    });

    return res.status(200).json(status);
  } catch (error) {
    return handleError(res, error, "Failed to load public payment redirect status");
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

    const hostedCheckout = await getHostedCheckoutHtml(paymentId, token);
    const formFields = hostedCheckout.formFields;
    console.log({
      source: "PAYHERE_HOSTED_FORM_DEBUG",
      merchant_id: formFields.merchant_id,
      order_id: formFields.order_id,
      amount: formFields.amount,
      currency: formFields.currency,
      return_url: formFields.return_url,
      cancel_url: formFields.cancel_url,
      notify_url: formFields.notify_url,
      items: formFields.items,
      first_name: formFields.first_name,
      last_name: formFields.last_name,
      email: formFields.email,
      phone: formFields.phone,
      address: formFields.address,
      city: formFields.city,
      country: formFields.country,
      fieldNames: Object.keys(formFields),
      hashLength: formFields.hash ? formFields.hash.length : 0,
      hashStart: formFields.hash ? formFields.hash.slice(0, 4) : null,
      hashEnd: formFields.hash ? formFields.hash.slice(-4) : null,
      merchantSecretLength: process.env.PAYHERE_MERCHANT_SECRET ? process.env.PAYHERE_MERCHANT_SECRET.trim().length : 0,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self' https://sandbox.payhere.lk https://www.payhere.lk; base-uri 'self'; frame-ancestors 'none'"
    );
    return res.status(200).send(hostedCheckout.html);
  } catch (error) {
    return handleError(res, error, "Failed to load hosted payment checkout");
  }
};

export const payHereNotifyController = async (req: Request, res: Response) => {
  try {
    const result = await updatePaymentFromGatewayNotification(req.body || {});

    console.info("[payments] PayHere notify controller result", {
      processed: result.processed,
      ignoredReason: result.ignoredReason ?? null,
      orderId: result.orderId ?? null,
      paymentId: result.paymentId ?? null,
      patientId: result.patientId ?? null,
      pharmacyId: result.pharmacyId ?? null,
      paymentStatus: result.paymentStatus ?? null,
      invoiceNo: result.invoiceNo ?? null,
    });

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
