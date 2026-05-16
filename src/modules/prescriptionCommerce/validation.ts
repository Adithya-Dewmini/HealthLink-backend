import { HttpError } from "../pharmacy/errors";
import type { CreatePrescriptionOrderInput } from "./types";

const asTrimmedString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const parsePositiveInt = (value: unknown, label: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `Valid ${label} is required`);
  }
  return parsed;
};

const asBoolean = (value: unknown, fallback = false) => {
  if (typeof value === "boolean") return value;
  return fallback;
};

const optionalTrimmedString = (value: unknown) => {
  const parsed = asTrimmedString(value);
  return parsed || null;
};

const parseDeliveryAddress = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
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

export const validatePrescriptionRouteId = (value: unknown) => {
  const parsed = asTrimmedString(value);
  if (!parsed) {
    throw new HttpError(400, "Valid prescription id is required");
  }
  return parsed;
};

export const validateCreatePrescriptionOrderPayload = (body: any): CreatePrescriptionOrderInput => {
  const pharmacyId = parsePositiveInt(body?.pharmacy_id ?? body?.pharmacyId, "pharmacy id");
  const acceptPartial = asBoolean(body?.accept_partial ?? body?.acceptPartial, false);
  const paymentMethodRaw = asTrimmedString(body?.payment_method ?? body?.paymentMethod).toLowerCase();
  const paymentMethod =
    paymentMethodRaw === "online"
      ? "online"
      : paymentMethodRaw === "cash" || paymentMethodRaw === "pay_at_pharmacy" || paymentMethodRaw === "cash_on_pickup"
        ? "cash"
        : null;
  const fulfillmentMethod =
    asTrimmedString(body?.fulfillment_method ?? body?.fulfillmentMethod ?? body?.fulfillment_type ?? body?.fulfillmentType)
      .toLowerCase() === "delivery"
      ? "delivery"
      : "pickup";
  const notes = typeof body?.notes === "string" && body.notes.trim() ? body.notes.trim() : null;

  if (fulfillmentMethod === "delivery") {
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
      pharmacyId,
      acceptPartial,
      fulfillmentMethod,
      paymentMethod,
      notes,
      deliveryAddress,
      deliveryNotes: optionalTrimmedString(body?.delivery_notes ?? body?.deliveryNotes),
      deliveryContactName,
      deliveryContactPhone,
    };
  }

  return {
    pharmacyId,
    acceptPartial,
    fulfillmentMethod,
    paymentMethod,
    notes,
    deliveryAddress: null,
    deliveryNotes: null,
    deliveryContactName: null,
    deliveryContactPhone: null,
  };
};
