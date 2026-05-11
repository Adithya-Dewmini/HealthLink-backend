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

export const validatePrescriptionRouteId = (value: unknown) => {
  const parsed = asTrimmedString(value);
  if (!parsed) {
    throw new HttpError(400, "Valid prescription id is required");
  }
  return parsed;
};

export const validateCreatePrescriptionOrderPayload = (body: any): CreatePrescriptionOrderInput => ({
  pharmacyId: parsePositiveInt(body?.pharmacy_id ?? body?.pharmacyId, "pharmacy id"),
  acceptPartial: asBoolean(body?.accept_partial ?? body?.acceptPartial, false),
  notes: typeof body?.notes === "string" && body.notes.trim() ? body.notes.trim() : null,
});
