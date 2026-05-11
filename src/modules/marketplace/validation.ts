import { HttpError } from "../pharmacy/errors";
import type {
  CreateMarketplaceProductInput,
  UpdateMarketplaceProductInput,
  UpdateMarketplaceVisibilityInput,
} from "./types";

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const asNullableTrimmedString = (value: unknown) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = asTrimmedString(value);
  return normalized || null;
};

const asPositiveNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const asNonNegativeNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const asBoolean = (value: unknown) => {
  if (typeof value === "boolean") return value;
  return undefined;
};

export const validateMarketplaceRouteId = (value: unknown, label: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `Valid ${label} is required`);
  }
  return parsed;
};

export const validateMarketplaceSearchQuery = (value: unknown) => {
  const query = asTrimmedString(value);
  if (!query) {
    throw new HttpError(400, "Search query is required");
  }
  return query;
};

export const validateCreateMarketplaceProductPayload = (
  body: any
): CreateMarketplaceProductInput => {
  const inventoryItemId = validateMarketplaceRouteId(
    body?.inventory_item_id ?? body?.inventoryItemId,
    "inventory item id"
  );
  const price = asPositiveNumber(body?.price);
  const discountPriceRaw = body?.discount_price ?? body?.discountPrice;
  const discountPrice =
    discountPriceRaw === undefined || discountPriceRaw === null || discountPriceRaw === ""
      ? null
      : asPositiveNumber(discountPriceRaw);

  if (!price) {
    throw new HttpError(400, "price must be greater than 0");
  }

  if (discountPriceRaw !== undefined && discountPriceRaw !== null && discountPriceRaw !== "" && !discountPrice) {
    throw new HttpError(400, "discount_price must be greater than 0 when provided");
  }

  if (discountPrice !== null && discountPrice >= price) {
    throw new HttpError(400, "discount_price must be less than price");
  }

  const imageUrl = asNullableTrimmedString(body?.image_url ?? body?.imageUrl);
  if (typeof imageUrl === "string" && imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    throw new HttpError(400, "image_url must be a valid URL");
  }

  return {
    inventoryItemId,
    name: asTrimmedString(body?.name) || undefined,
    genericName: asNullableTrimmedString(body?.generic_name ?? body?.genericName),
    brand: asNullableTrimmedString(body?.brand),
    description: asNullableTrimmedString(body?.description),
    category: asNullableTrimmedString(body?.category),
    price,
    discountPrice,
    imageUrl,
    requiresPrescription: asBoolean(body?.requires_prescription ?? body?.requiresPrescription),
    isFeatured: asBoolean(body?.is_featured ?? body?.isFeatured),
    isActive: asBoolean(body?.is_active ?? body?.isActive),
  };
};

export const validateUpdateMarketplaceProductPayload = (
  idValue: unknown,
  body: any
): UpdateMarketplaceProductInput => {
  const id = validateMarketplaceRouteId(idValue, "marketplace product id");
  const payload: UpdateMarketplaceProductInput = { id };

  const name = asTrimmedString(body?.name);
  if (name) payload.name = name;

  const genericName = asNullableTrimmedString(body?.generic_name ?? body?.genericName);
  if (genericName !== undefined) payload.genericName = genericName;

  const brand = asNullableTrimmedString(body?.brand);
  if (brand !== undefined) payload.brand = brand;

  const description = asNullableTrimmedString(body?.description);
  if (description !== undefined) payload.description = description;

  const category = asNullableTrimmedString(body?.category);
  if (category !== undefined) payload.category = category;

  if (body?.price !== undefined) {
    const price = asPositiveNumber(body.price);
    if (!price) {
      throw new HttpError(400, "price must be greater than 0");
    }
    payload.price = price;
  }

  if (body?.discount_price !== undefined || body?.discountPrice !== undefined) {
    const raw = body?.discount_price ?? body?.discountPrice;
    if (raw === null || raw === "") {
      payload.discountPrice = null;
    } else {
      const discountPrice = asPositiveNumber(raw);
      if (!discountPrice) {
        throw new HttpError(400, "discount_price must be greater than 0 when provided");
      }
      payload.discountPrice = discountPrice;
    }
  }

  const imageUrl = asNullableTrimmedString(body?.image_url ?? body?.imageUrl);
  if (imageUrl !== undefined) {
    if (typeof imageUrl === "string" && imageUrl && !/^https?:\/\//i.test(imageUrl)) {
      throw new HttpError(400, "image_url must be a valid URL");
    }
    payload.imageUrl = imageUrl;
  }

  const requiresPrescription = asBoolean(body?.requires_prescription ?? body?.requiresPrescription);
  if (requiresPrescription !== undefined) payload.requiresPrescription = requiresPrescription;

  const isFeatured = asBoolean(body?.is_featured ?? body?.isFeatured);
  if (isFeatured !== undefined) payload.isFeatured = isFeatured;

  const isActive = asBoolean(body?.is_active ?? body?.isActive);
  if (isActive !== undefined) payload.isActive = isActive;

  if (payload.price !== undefined && payload.discountPrice !== undefined && payload.discountPrice !== null && payload.discountPrice >= payload.price) {
    throw new HttpError(400, "discount_price must be less than price");
  }

  if (Object.keys(payload).length === 1) {
    throw new HttpError(400, "At least one field is required to update a marketplace product");
  }

  return payload;
};

export const validateMarketplaceVisibilityPayload = (
  idValue: unknown,
  body: any
): UpdateMarketplaceVisibilityInput => {
  const id = validateMarketplaceRouteId(idValue, "marketplace product id");
  const isActive = asBoolean(body?.is_active ?? body?.isActive);

  if (isActive === undefined) {
    throw new HttpError(400, "is_active must be provided");
  }

  return { id, isActive };
};
