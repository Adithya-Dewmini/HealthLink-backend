import { HttpError } from "../pharmacy/errors";
import {
  ORDER_STATUSES,
  type CheckoutInput,
  type DeliveryAddress,
  type OrderStatus,
  type RejectOrderInput,
  type ReviewOrderInput,
  type ReviewOrderItemInput,
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
  const paymentMethodRaw = asTrimmedString(body?.payment_method ?? body?.paymentMethod).toLowerCase();
  const paymentMethod =
    paymentMethodRaw === "online"
      ? "online"
      : paymentMethodRaw === "cash" || paymentMethodRaw === "pay_at_pharmacy" || paymentMethodRaw === "cash_on_pickup"
        ? "cash"
        : null;
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
      paymentMethod,
      notes: notes || null,
      deliveryAddress,
      deliveryNotes: optionalTrimmedString(body?.delivery_notes ?? body?.deliveryNotes),
      deliveryContactName,
      deliveryContactPhone,
    };
  }

  return {
    fulfillmentType: "pickup",
    paymentMethod,
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
  const rawStatus = asTrimmedString(body?.status).toLowerCase();
  const status = rawStatus === "accepted"
    ? "confirmed"
    : rawStatus === "pending_review"
      ? "pending"
      : rawStatus === "partially_fulfilled"
        ? "partially_ready"
        : rawStatus;

  if (!isOrderStatus(status)) {
    throw new HttpError(400, `status must be one of: ${ORDER_STATUSES.join(", ")}`);
  }

  return { id, status, note: optionalTrimmedString(body?.note) };
};

const REVIEW_ITEM_STATUSES = ["available", "partial", "unavailable", "substituted"] as const;

const parseNonNegativeInt = (value: unknown, label: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, `Valid ${label} is required`);
  }
  return parsed;
};

const validateReviewItem = (item: any): ReviewOrderItemInput => {
  const itemStatus = asTrimmedString(item?.itemStatus ?? item?.item_status).toLowerCase();
  if (!REVIEW_ITEM_STATUSES.includes(itemStatus as ReviewOrderItemInput["itemStatus"])) {
    throw new HttpError(400, "Valid item status is required");
  }

  const approvedQuantity = parseNonNegativeInt(
    item?.approvedQuantity ?? item?.approved_quantity,
    "approved quantity"
  );
  const note = optionalTrimmedString(item?.note);

  if (itemStatus === "unavailable" && !note) {
    throw new HttpError(400, "Unavailable items require a note");
  }

  return {
    orderItemId: parsePositiveInt(item?.orderItemId ?? item?.order_item_id, "order item id"),
    inventoryItemId:
      item?.inventoryItemId === null || item?.inventory_item_id === null
        ? null
        : item?.inventoryItemId !== undefined || item?.inventory_item_id !== undefined
          ? parsePositiveInt(item?.inventoryItemId ?? item?.inventory_item_id, "inventory item id")
          : undefined,
    approvedQuantity,
    itemStatus: itemStatus as ReviewOrderItemInput["itemStatus"],
    substitutionName: optionalTrimmedString(item?.substitutionName ?? item?.substitution_name),
    note,
  };
};

export const validateReviewOrderPayload = (idValue: unknown, body: any): ReviewOrderInput => {
  const id = validateOrderRouteId(idValue);
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  if (!rawItems.length) {
    throw new HttpError(400, "At least one review item is required");
  }

  return {
    id,
    items: rawItems.map(validateReviewItem),
    pharmacistNote: optionalTrimmedString(body?.pharmacistNote ?? body?.pharmacist_note),
  };
};

export const validateRejectOrderPayload = (idValue: unknown, body: any): RejectOrderInput => {
  const id = validateOrderRouteId(idValue);
  const reason = asTrimmedString(body?.reason);
  if (!reason) {
    throw new HttpError(400, "Rejection reason is required");
  }
  return { id, reason };
};
