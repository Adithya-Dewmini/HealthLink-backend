import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../../types/auth";
import { formatApiError } from "../../middleware/errorHandler";
import { assertVerifiedPharmacyForUser } from "../../services/verification.service";
import {
  createNotificationAndPush,
  getPharmacyMemberUserIds,
} from "../../services/notification.service";
import { createAuditLog, getAuditRequestContext } from "../../services/audit.service";
import { emitOrderCreated, emitOrderUpdated, emitPrescriptionUpdated } from "../../services/realtime.service";
import { HttpError, isHttpError } from "../pharmacy/errors";
import {
  cancelPatientOrder,
  checkoutCart,
  getPatientOrderDetails,
  getPatientOrders,
  getPharmacyOrderDetails,
  getPharmacyOrders,
  rejectPharmacyOrder,
  reviewPharmacyOrder,
  updatePharmacyOrderStatus,
} from "./service";
import {
  getPatientOrderTimeline,
  getPharmacyOrderTimeline,
  recordActivityLog,
} from "../activity/service";
import {
  validateCheckoutPayload,
  validateOrderRouteId,
  validateRejectOrderPayload,
  validateReviewOrderPayload,
  validateOrderStatusPayload,
} from "./validation";

const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
  if (isHttpError(error)) {
    const formatted = formatApiError(error);
    return res.status(formatted.statusCode).json(formatted.body);
  }

  console.error(fallbackMessage, error);
  const formatted = formatApiError(Object.assign(new Error(fallbackMessage), { statusCode: 500 }));
  return res.status(formatted.statusCode).json(formatted.body);
};

const mapCheckoutErrorForClient = (error: unknown) => {
  const message = String((error as Error | undefined)?.message || "").toLowerCase();
  const statusCode = Number((error as { statusCode?: number } | undefined)?.statusCode || 0);

  if ([400, 401, 403].includes(statusCode) && isHttpError(error)) {
    return error as HttpError;
  }

  if (statusCode === 503 || message.includes("payment gateway is not configured")) {
    return new HttpError(503, "Payment gateway is not configured");
  }

  if (
    statusCode === 409 &&
    (
      message.includes("stock") ||
      message.includes("not available") ||
      message.includes("cart is empty") ||
      message.includes("product") ||
      message.includes("pharmacy storefront")
    )
  ) {
    return new HttpError(409, "Some medicines are no longer available.");
  }

  return new HttpError(500, "Unable to complete checkout. Please try again.");
};

const requirePatientUser = (req: Request) => {
  const typedReq = req as AuthenticatedRequest;
  const userId = typedReq.user?.id;
  const role = String(typedReq.user?.role || "").toLowerCase();

  if (!userId) {
    throw new HttpError(401, "Unauthorized");
  }

  if (role !== "patient" && role !== "user") {
    throw new HttpError(403, "Only patients can access orders");
  }

  return Number(userId);
};

const requireVerifiedPharmacist = async (req: Request) => {
  const typedReq = req as AuthenticatedRequest;
  const userId = typedReq.user?.id;
  const role = String(typedReq.user?.role || "").toLowerCase();

  if (!userId) {
    throw new HttpError(401, "Unauthorized");
  }

  if (role !== "pharmacist") {
    throw new HttpError(403, "Only pharmacists can manage pharmacy orders");
  }

  await assertVerifiedPharmacyForUser(Number(userId));
  return Number(userId);
};

const notifyPharmacyOrderCreated = async (input: {
  patientId: number;
  pharmacyId: number;
  pharmacyName: string;
  orderId: number;
  prescriptionId?: string | null;
}) => {
  const pharmacyUserIds = await getPharmacyMemberUserIds(input.pharmacyId);
  await Promise.all(
    pharmacyUserIds.map((userId) =>
      createNotificationAndPush({
        userId,
        title: "New pharmacy order",
        body: input.prescriptionId
          ? `Prescription order #${input.orderId} is ready for review.`
          : `New marketplace order #${input.orderId} was placed.`,
        type: "pharmacy_order_created",
        metadata: {
          orderId: input.orderId,
          pharmacyId: input.pharmacyId,
          patientId: input.patientId,
          prescriptionId: input.prescriptionId ?? null,
          pharmacyName: input.pharmacyName,
        },
      })
    )
  );
};

const notifyOrderStatusChange = async (order: Awaited<ReturnType<typeof checkoutCart>>["order"]) => {
  emitOrderUpdated(order);
  if (order.prescriptionId) {
    emitPrescriptionUpdated({
      prescriptionId: order.prescriptionId,
      patientId: order.patientId,
      pharmacyId: order.pharmacyId,
      orderId: order.id,
      status: order.status,
    });
  }

  const labelByStatus: Record<string, { title: string; body: string; type: string }> = {
    confirmed: {
      title: "Order confirmed",
      body: `${order.pharmacyName} confirmed order #${order.id}.`,
      type: "order_confirmed",
    },
    ready_for_pickup: {
      title: "Ready for pickup",
      body: `Order #${order.id} is ready for pickup at ${order.pharmacyName}.`,
      type: order.prescriptionId ? "prescription_fulfillment_ready" : "order_ready_for_pickup",
    },
    out_for_delivery: {
      title: "Out for delivery",
      body: `Order #${order.id} is on the way from ${order.pharmacyName}.`,
      type: "order_out_for_delivery",
    },
    delivered: {
      title: "Delivered",
      body: `Order #${order.id} was delivered successfully.`,
      type: "order_delivered",
    },
    awaiting_substitution_approval: {
      title: "Substitution approval required",
      body: `Order #${order.id} needs your approval for a substitution.`,
      type: "substitution_approval_required",
    },
    completed: {
      title: "Order completed",
      body: `Order #${order.id} has been completed.`,
      type: "order_completed",
    },
    cancelled: {
      title: "Order cancelled",
      body: `Order #${order.id} was cancelled.`,
      type: "order_cancelled",
    },
    rejected: {
      title: "Order rejected",
      body: `Order #${order.id} was rejected by ${order.pharmacyName}.`,
      type: "order_rejected",
    },
  };

  const notification = labelByStatus[order.status];
  if (notification) {
    await createNotificationAndPush({
      userId: order.patientId,
      title: notification.title,
      body: notification.body,
      type: notification.type,
      metadata: {
        orderId: order.id,
        pharmacyId: order.pharmacyId,
        prescriptionId: order.prescriptionId ?? null,
        status: order.status,
      },
    });
  }
};

const recordOrderLifecycleActivity = async (
  order: Awaited<ReturnType<typeof checkoutCart>>["order"],
  type: string
) => {
  const messageByType: Record<string, { title: string; description: string }> = {
    order_created: {
      title: "Order created",
      description: `Your order #${order.id} was placed with ${order.pharmacyName}.`,
    },
    order_confirmed: {
      title: "Order confirmed",
      description: `${order.pharmacyName} confirmed order #${order.id}.`,
    },
    order_preparing: {
      title: "Preparing medicines",
      description: `${order.pharmacyName} is preparing order #${order.id}.`,
    },
    order_ready_for_pickup: {
      title: "Ready for pickup",
      description: `Order #${order.id} is ready for pickup.`,
    },
    order_out_for_delivery: {
      title: "Delivery started",
      description: `Order #${order.id} is out for delivery.`,
    },
    order_delivered: {
      title: "Delivered",
      description: `Order #${order.id} was delivered successfully.`,
    },
    order_completed: {
      title: "Completed",
      description: `Order #${order.id} was completed successfully.`,
    },
    order_cancelled: {
      title: "Cancelled",
      description: `Order #${order.id} was cancelled.`,
    },
    order_rejected: {
      title: "Rejected",
      description: `Order #${order.id} was rejected.`,
    },
    order_reviewed: {
      title: "Order reviewed",
      description: `${order.pharmacyName} reviewed order #${order.id}.`,
    },
    substitution_approval_required: {
      title: "Substitution approval required",
      description: `Order #${order.id} is waiting for your substitution approval.`,
    },
    partially_ready: {
      title: "Partially ready",
      description: `Part of order #${order.id} is ready for fulfillment.`,
    },
  };

  const entry = messageByType[type];
  if (!entry) {
    return;
  }

  await recordActivityLog({
    userId: order.patientId,
    orderId: order.id,
    prescriptionId: order.prescriptionId,
    type,
    title: entry.title,
    description: entry.description,
    metadata: {
      orderId: order.id,
      pharmacyId: order.pharmacyId,
      pharmacyName: order.pharmacyName,
      status: order.status,
      fulfillmentType: order.fulfillmentType,
    },
  });
};

export const checkoutController = async (req: Request, res: Response) => {
  try {
    const patientId = requirePatientUser(req);
    const payload = validateCheckoutPayload(req.body);
    const data = await checkoutCart(patientId, payload);
    if (!(data.order.paymentMethod === "online" && data.order.paymentStatus === "pending")) {
      await notifyPharmacyOrderCreated({
        patientId,
        pharmacyId: data.order.pharmacyId,
        pharmacyName: data.order.pharmacyName,
        orderId: data.order.id,
        prescriptionId: data.order.prescriptionId,
      });
    }
    emitOrderCreated(data.order);
    emitOrderUpdated(data.order);
    await recordOrderLifecycleActivity(data.order, "order_created");
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: patientId,
      actorRole: "patient",
      userId: patientId,
      action: "order_created",
      entityType: "order",
      entityId: data.order.id,
      metadata: {
        pharmacyId: data.order.pharmacyId,
        prescriptionId: data.order.prescriptionId,
        fulfillmentType: data.order.fulfillmentType,
        total: data.order.total,
      },
    });
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, mapCheckoutErrorForClient(error), "Failed to complete checkout");
  }
};

export const getMyOrdersController = async (req: Request, res: Response) => {
  try {
    const patientId = requirePatientUser(req);
    const data = await getPatientOrders(patientId);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to load orders");
  }
};

export const getPatientOrderController = async (req: Request, res: Response) => {
  try {
    const patientId = requirePatientUser(req);
    const orderId = validateOrderRouteId(req.params.id);
    const data = await getPatientOrderDetails(patientId, orderId);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to load order");
  }
};

export const getPatientOrderTimelineController = async (req: Request, res: Response) => {
  try {
    const patientId = requirePatientUser(req);
    const orderId = validateOrderRouteId(req.params.id);
    const data = await getPatientOrderTimeline(patientId, orderId);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to load order timeline");
  }
};

export const cancelPatientOrderController = async (req: Request, res: Response) => {
  try {
    const patientId = requirePatientUser(req);
    const orderId = validateOrderRouteId(req.params.id);
    const data = await cancelPatientOrder(patientId, orderId);
    await notifyOrderStatusChange(data.order);
    await recordOrderLifecycleActivity(data.order, "order_cancelled");
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: patientId,
      actorRole: "patient",
      userId: patientId,
      action: "order_cancelled",
      entityType: "order",
      entityId: data.order.id,
      metadata: {
        pharmacyId: data.order.pharmacyId,
        prescriptionId: data.order.prescriptionId,
      },
    });
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to cancel order");
  }
};

export const getPharmacyOrdersController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacist(req);
    const data = await getPharmacyOrders(pharmacistUserId);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to load pharmacy orders");
  }
};

export const getPharmacyOrderController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacist(req);
    const orderId = validateOrderRouteId(req.params.id);
    const data = await getPharmacyOrderDetails(pharmacistUserId, orderId);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to load pharmacy order");
  }
};

export const getPharmacyOrderTimelineController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacist(req);
    const orderId = validateOrderRouteId(req.params.id);
    const data = await getPharmacyOrderTimeline(pharmacistUserId, orderId);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to load pharmacy order timeline");
  }
};

export const updatePharmacyOrderStatusController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacist(req);
    const payload = validateOrderStatusPayload(req.params.id, req.body);
    const data = await updatePharmacyOrderStatus(pharmacistUserId, payload);
    await notifyOrderStatusChange(data.order);
    const activityTypeMap: Record<string, string> = {
      confirmed: "order_confirmed",
      preparing: "order_preparing",
      ready_for_pickup: "order_ready_for_pickup",
      out_for_delivery: "order_out_for_delivery",
      delivered: "order_delivered",
      completed: "order_completed",
      cancelled: "order_cancelled",
      rejected: "order_rejected",
      awaiting_substitution_approval: "substitution_approval_required",
      partially_ready: "partially_ready",
    };
    const activityType = activityTypeMap[data.order.status];
    if (activityType) {
      await recordOrderLifecycleActivity(data.order, activityType);
    }
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: pharmacistUserId,
      actorRole: "pharmacist",
      userId: pharmacistUserId,
      action: "order_status_changed",
      entityType: "order",
      entityId: data.order.id,
      metadata: {
        status: data.order.status,
        pharmacyId: data.order.pharmacyId,
        prescriptionId: data.order.prescriptionId,
      },
    });
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to update pharmacy order");
  }
};

export const reviewPharmacyOrderController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacist(req);
    const payload = validateReviewOrderPayload(req.params.id, req.body);
    const data = await reviewPharmacyOrder(pharmacistUserId, payload);
    await notifyOrderStatusChange(data.order);
    await recordOrderLifecycleActivity(data.order, "order_reviewed");
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: pharmacistUserId,
      actorRole: "pharmacist",
      userId: pharmacistUserId,
      action: "order_reviewed",
      entityType: "order",
      entityId: data.order.id,
      metadata: {
        status: data.order.status,
        pharmacyId: data.order.pharmacyId,
        prescriptionId: data.order.prescriptionId,
      },
    });
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to review pharmacy order");
  }
};

export const rejectPharmacyOrderController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacist(req);
    const payload = validateRejectOrderPayload(req.params.id, req.body);
    const data = await rejectPharmacyOrder(pharmacistUserId, payload);
    await notifyOrderStatusChange(data.order);
    await recordOrderLifecycleActivity(data.order, "order_rejected");
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: pharmacistUserId,
      actorRole: "pharmacist",
      userId: pharmacistUserId,
      action: "order_rejected",
      entityType: "order",
      entityId: data.order.id,
      metadata: {
        pharmacyId: data.order.pharmacyId,
        prescriptionId: data.order.prescriptionId,
        reason: payload.reason,
      },
    });
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to reject pharmacy order");
  }
};

export const completePharmacyOrderController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacist(req);
    const orderId = validateOrderRouteId(req.params.id);
    const data = await updatePharmacyOrderStatus(pharmacistUserId, {
      id: orderId,
      status: "completed",
      note: typeof req.body?.note === "string" ? req.body.note.trim() || null : null,
    });
    await notifyOrderStatusChange(data.order);
    await recordOrderLifecycleActivity(data.order, "order_completed");
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: pharmacistUserId,
      actorRole: "pharmacist",
      userId: pharmacistUserId,
      action: "order_completed",
      entityType: "order",
      entityId: data.order.id,
      metadata: {
        pharmacyId: data.order.pharmacyId,
        prescriptionId: data.order.prescriptionId,
      },
    });
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to complete pharmacy order");
  }
};
