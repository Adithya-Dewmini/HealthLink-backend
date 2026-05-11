import { HttpError } from "../pharmacy/errors";
import type { CartItemInput, UpdateCartItemInput } from "./types";

const parsePositiveInt = (value: unknown, label: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return parsed;
};

export const validateCartItemPayload = (body: any): CartItemInput => ({
  marketplaceProductId: parsePositiveInt(
    body?.marketplace_product_id ?? body?.marketplaceProductId,
    "marketplace_product_id"
  ),
  quantity: parsePositiveInt(body?.quantity, "quantity"),
});

export const validateCartItemUpdatePayload = (
  idValue: unknown,
  body: any
): UpdateCartItemInput => ({
  id: parsePositiveInt(idValue, "cart item id"),
  quantity: parsePositiveInt(body?.quantity, "quantity"),
});

export const validateCartItemRouteId = (value: unknown) =>
  parsePositiveInt(value, "cart item id");
