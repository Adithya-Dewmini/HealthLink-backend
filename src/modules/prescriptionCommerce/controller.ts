import type { Response } from "express";
import type { AuthenticatedRequest } from "../../types/auth";
import { formatApiError } from "../../middleware/errorHandler";
import {
  createNotificationAndPush,
  getPharmacyMemberUserIds,
} from "../../services/notification.service";
import { emitOrderUpdated, emitPrescriptionUpdated } from "../../services/realtime.service";
import { recordActivityLog } from "../activity/service";
import { HttpError, isHttpError } from "../pharmacy/errors";
import {
  buildPrescriptionCartMatches,
  createPrescriptionLinkedOrder,
} from "./service";
import {
  validateCreatePrescriptionOrderPayload,
  validatePrescriptionRouteId,
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

const requirePatientUser = (req: AuthenticatedRequest) => {
  const role = String(req.user?.role || "").toLowerCase();
  const patientId = req.user?.id;

  if (!patientId) {
    throw new HttpError(401, "Unauthorized");
  }

  if (role !== "patient" && role !== "user") {
    throw new HttpError(403, "Only patients can manage prescription fulfillment");
  }

  return Number(patientId);
};

export const buildPrescriptionCartController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const patientId = requirePatientUser(req);
    const prescriptionId = validatePrescriptionRouteId(req.params.id);
    const data = await buildPrescriptionCartMatches(patientId, prescriptionId);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to build prescription fulfillment options");
  }
};

export const createPrescriptionOrderController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const patientId = requirePatientUser(req);
    const prescriptionId = validatePrescriptionRouteId(req.params.id);
    const payload = validateCreatePrescriptionOrderPayload(req.body);
    const data = await createPrescriptionLinkedOrder(patientId, prescriptionId, payload);
    const pharmacyUserIds = await getPharmacyMemberUserIds(data.order.pharmacyId);
    await Promise.all(
      pharmacyUserIds.map((userId) =>
        createNotificationAndPush({
          userId,
          title: "New prescription order",
          body: `Prescription order #${data.order.id} is ready for pharmacist review.`,
          type: "pharmacy_order_created",
          metadata: {
            orderId: data.order.id,
            pharmacyId: data.order.pharmacyId,
            patientId: data.order.patientId,
            prescriptionId: data.order.prescriptionId,
          },
        })
      )
    );
    emitOrderUpdated(data.order);
    emitPrescriptionUpdated({
      prescriptionId: data.order.prescriptionId || prescriptionId,
      patientId: data.order.patientId,
      pharmacyId: data.order.pharmacyId,
      orderId: data.order.id,
      status: data.order.status,
      metadata: {
        fulfillmentCoverage: data.fulfillment.coveragePercentage,
        fullyAvailable: data.fulfillment.fullyAvailable,
      },
    });
    await recordActivityLog({
      userId: data.order.patientId,
      orderId: data.order.id,
      prescriptionId: data.order.prescriptionId || prescriptionId,
      type: "order_created",
      title: "Prescription order created",
      description: `Prescription fulfillment order #${data.order.id} was placed with ${data.order.pharmacyName}.`,
      metadata: {
        orderId: data.order.id,
        prescriptionId: data.order.prescriptionId || prescriptionId,
        pharmacyId: data.order.pharmacyId,
        pharmacyName: data.order.pharmacyName,
        status: data.order.status,
        coveragePercentage: data.fulfillment.coveragePercentage,
        fullyAvailable: data.fulfillment.fullyAvailable,
      },
    });
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to create prescription-linked order");
  }
};
