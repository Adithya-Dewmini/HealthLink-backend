import { HttpError } from "./errors";

export type SelectedItemInput = {
  prescriptionItemId: number | null;
  medicineId: number | null;
  quantity: number;
  unitPrice: number | null;
};

export type DemandItemInput = {
  medicineId: number;
  quantity: number;
};

export type CreateMedicineInput = {
  name: string;
  categoryId: number;
  brandId: number;
  description: string | null;
  imageUrl: string | null;
  quantity: number;
  expiryDate: string;
  price: number;
};

export type UpdateMedicineInput = CreateMedicineInput & {
  id: number;
};

export type RestockMedicineInput = {
  id: number;
  quantity: number;
};

export type CreateLookupInput = {
  name: string;
};

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const asPositiveNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const validateMedicineId = (value: unknown) => {
  const id = asPositiveNumber(value);
  if (!id) {
    throw new HttpError(400, "Valid medicine id is required");
  }
  return id;
};

export const validatePrescriptionId = (value: unknown) => {
  const id = asTrimmedString(value);
  if (!id) {
    throw new HttpError(400, "Valid prescription id is required");
  }
  return id;
};

export const validateQrToken = (value: unknown) => {
  const token = asTrimmedString(value);
  if (!token) {
    throw new HttpError(400, "qrToken is required");
  }
  return token;
};

export const validateOptionalPharmacyId = (value: unknown) => {
  if (value === undefined || value === null || value === "") return null;
  return asTrimmedString(value);
};

export const normalizeSelectedItems = (items: unknown, requirePrescriptionItemId: boolean) => {
  if (!Array.isArray(items) || !items.length) {
    throw new HttpError(400, "selected_items/items must be a non-empty array");
  }

  const merged = new Map<string, SelectedItemInput>();

  for (const item of items) {
    const prescriptionItemId = asPositiveNumber(
      (item as any)?.prescription_item_id ?? (item as any)?.item_id ?? (item as any)?.id
    );
    const medicineId = asPositiveNumber((item as any)?.medicine_id);
    const quantity = asPositiveNumber((item as any)?.quantity ?? 1);
    const unitPriceRaw = (item as any)?.unit_price;
    const unitPrice =
      unitPriceRaw === undefined || unitPriceRaw === null ? null : asPositiveNumber(unitPriceRaw);

    if (!quantity) {
      throw new HttpError(400, "Each item must include a positive quantity");
    }

    if (requirePrescriptionItemId && !prescriptionItemId) {
      throw new HttpError(400, "Each item must include a valid prescription item id");
    }

    if (!requirePrescriptionItemId && !prescriptionItemId && !medicineId) {
      throw new HttpError(400, "Each item must include medicine_id or prescription_item_id");
    }

    const key = prescriptionItemId
      ? `prescription:${prescriptionItemId}`
      : `medicine:${medicineId}`;
    const existing = merged.get(key);

    merged.set(key, {
      prescriptionItemId,
      medicineId,
      quantity: (existing?.quantity || 0) + quantity,
      unitPrice: unitPrice ?? existing?.unitPrice ?? null,
    });
  }

  return Array.from(merged.values());
};

export const validateDispensePayload = (body: any) => {
  const prescriptionId = validatePrescriptionId(body?.prescription_id);
  const pharmacyId = body?.pharmacy_id;
  const pharmacistUserId = body?.pharmacist_user_id ?? null;

  if (pharmacyId === undefined || pharmacyId === null || pharmacyId === "") {
    throw new HttpError(400, "pharmacy_id is required");
  }

  return {
    prescriptionId,
    pharmacyId,
    pharmacistUserId,
    selectedItems: normalizeSelectedItems(body?.selected_items, true),
  };
};

export const validateSalePayload = (body: any) => {
  const pharmacyId = body?.pharmacy_id;
  if (pharmacyId === undefined || pharmacyId === null || pharmacyId === "") {
    throw new HttpError(400, "pharmacy_id is required");
  }

  return {
    pharmacyId,
    prescriptionId: body?.prescription_id ?? null,
    pharmacistUserId: body?.pharmacist_user_id ?? null,
    items: normalizeSelectedItems(body?.items, false),
  };
};

export const validateDemandLogPayload = (body: any) => {
  const payloadItems = Array.isArray(body?.items)
    ? body.items
    : body?.medicine_id
      ? [{ medicine_id: body.medicine_id, quantity: body.quantity }]
      : [];

  if (!payloadItems.length) {
    throw new HttpError(400, "Provide items[] or medicine_id with quantity");
  }

  const items: DemandItemInput[] = payloadItems.map((item: any) => {
    const medicineId = asPositiveNumber(item?.medicine_id);
    const quantity = asPositiveNumber(item?.quantity ?? 1);

    if (!medicineId || !quantity) {
      throw new HttpError(400, "Each demand item requires medicine_id and positive quantity");
    }

    return { medicineId, quantity };
  });

  return {
    pharmacyId: body?.pharmacy_id ?? null,
    prescriptionId: body?.prescription_id ?? null,
    source: asTrimmedString(body?.source) || "dispense",
    items,
  };
};

export const validateCreateMedicinePayload = (body: any): CreateMedicineInput => {
  const name = asTrimmedString(body?.name);

  if (!name) {
    throw new HttpError(400, "name is required");
  }

  const categoryId = validateMedicineId(body?.category_id);
  const brandId = validateMedicineId(body?.brand_id);
  const description = asTrimmedString(body?.description) || null;
  const imageUrl = asTrimmedString(body?.image_url) || null;
  const quantity = asPositiveNumber(body?.quantity);
  const expiryDate = asTrimmedString(body?.expiry_date);
  const price = asPositiveNumber(body?.price);

  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    throw new HttpError(400, "image_url must be a valid URL");
  }

  if (!quantity) {
    throw new HttpError(400, "quantity is required");
  }

  if (!expiryDate) {
    throw new HttpError(400, "expiry_date is required");
  }

  if (Number.isNaN(Date.parse(expiryDate))) {
    throw new HttpError(400, "expiry_date must be a valid date");
  }

  if (!price) {
    throw new HttpError(400, "price is required");
  }

  return {
    name,
    categoryId,
    brandId,
    description,
    imageUrl,
    quantity,
    expiryDate,
    price,
  };
};

export const validateUpdateMedicinePayload = (
  idValue: unknown,
  body: any
): UpdateMedicineInput => {
  const payload = validateCreateMedicinePayload(body);
  return {
    id: validateMedicineId(idValue),
    ...payload,
  };
};

export const validateRestockMedicinePayload = (
  idValue: unknown,
  body: any
): RestockMedicineInput => {
  const id = validateMedicineId(idValue);
  const quantity = asPositiveNumber(body?.quantity);

  if (!quantity) {
    throw new HttpError(400, "Restock quantity must be greater than 0");
  }

  return { id, quantity };
};

export const validateCreateLookupPayload = (body: any): CreateLookupInput => {
  const name = asTrimmedString(body?.name);

  if (!name) {
    throw new HttpError(400, "name is required");
  }

  return { name };
};
