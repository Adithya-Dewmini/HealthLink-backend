import { HttpError } from "../pharmacy/errors";
import {
  ORDER_STATUSES,
  type CheckoutInput,
  type DeliveryAddress,
  type OrderStatus,
  type UpdateOrderStatusInput,
} from "./types";

const asTrimmedString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const parsePositiveInt = (value: unknown, label: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `Valid ${label} is required`);
  }
  return parsed;
};

const isOrderStatus = (value: string): value is OrderStatus =>
  ORDER_STATUSES.includes(value as OrderStatus);

const optionalTrimmedString = (value: unknown) => {
  const parsed = asTrimmedString(value);
  return parsed || null;
};

const parseDeliveryAddress = (value: unknown): DeliveryAddress => {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "Delivery address is required");
  }

  const candidate = value as Record<string, unknown>;
  const line1 = asTrimmedString(candidate.line1);

  if (!line1) {
    throw new HttpError(400, "delivery_address.line1 is required");
  }

  return {
    line1,
    line2: optionalTrimmedString(candidate.line2),
    city: optionalTrimmedString(candidate.city),
    district: optionalTrimmedString(candidate.district),
    postalCode: optionalTrimmedString(candidate.postalCode ?? candidate.postal_code),
    landmark: optionalTrimmedString(candidate.landmark),
  };
};

export const validateCheckoutPayload = (body: any): CheckoutInput => {
  const fulfillmentType = asTrimmedString(body?.fulfillment_type ?? body?.fulfillmentType).toLowerCase();
  const notes = asTrimmedString(body?.notes);

  if (fulfillmentType !== "pickup" && fulfillmentType !== "delivery") {
    throw new HttpError(400, "fulfillment_type must be pickup or delivery");
  }

  if (fulfillmentType === "delivery") {
    const deliveryAddress = parseDeliveryAddress(body?.delivery_address ?? body?.deliveryAddress);
    const deliveryContactName = optionalTrimmedString(
      body?.delivery_contact_name ?? body?.deliveryContactName
    );
    const deliveryContactPhone = optionalTrimmedString(
      body?.delivery_contact_phone ?? body?.deliveryContactPhone
    );

    if (!deliveryContactName) {
      throw new HttpError(400, "delivery_contact_name is required for delivery orders");
    }

    if (!deliveryContactPhone) {
      throw new HttpError(400, "delivery_contact_phone is required for delivery orders");
    }

    return {
      fulfillmentType: "delivery",
      notes: notes || null,
      deliveryAddress,
      deliveryNotes: optionalTrimmedString(body?.delivery_notes ?? body?.deliveryNotes),
      deliveryContactName,
      deliveryContactPhone,
    };
  }

  return {
    fulfillmentType: "pickup",
    notes: notes || null,
    deliveryAddress: null,
    deliveryNotes: null,
    deliveryContactName: null,
    deliveryContactPhone: null,
  };
};

export const validateOrderRouteId = (value: unknown) => parsePositiveInt(value, "order id");

export const validateOrderStatusPayload = (
  idValue: unknown,
  body: any
): UpdateOrderStatusInput => {
  const id = validateOrderRouteId(idValue);
  const status = asTrimmedString(body?.status).toLowerCase();

  if (!isOrderStatus(status)) {
    throw new HttpError(400, `status must be one of: ${ORDER_STATUSES.join(", ")}`);
  }

  return { id, status };
};
