import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../../types/auth";
import { verifyPrescriptionToken } from "../../services/prescription.service";
import { createAuditLog, getAuditRequestContext } from "../../services/audit.service";
import { emitInventoryUpdated } from "../../services/realtime.service";
import { assertVerifiedPharmacyForUser } from "../../services/verification.service";
import { isHttpError } from "./errors";
import {
  createBrand,
  createCategory,
  createMedicine,
  createDemandLog,
  createSale,
  deleteMedicine,
  dispensePrescription,
  dispensePrescriptionById,
  fetchPharmacyProfileByUserId,
  fetchBrands,
  fetchCategories,
  fetchInventory,
  fetchPrescriptionById,
  fetchPrescriptionByQr,
  restockMedicine,
  updateMedicine,
} from "./service";
import {
  validateCreateLookupPayload,
  validateCreateMedicinePayload,
  validateDemandLogPayload,
  validateDispensePayload,
  validateMedicineId,
  validatePrescriptionId,
  validateQrToken,
  validateRestockMedicinePayload,
  validateSalePayload,
  validateUpdateMedicinePayload,
} from "./validation";

const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
  if (isHttpError(error)) {
    return res.status(error.statusCode).json({
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
  }

  console.error(fallbackMessage, error);
  return res.status(500).json({ message: fallbackMessage });
};

export const requireVerifiedPharmacistUser = async (req: Request) => {
  const typedReq = req as AuthenticatedRequest;
  const userId = typedReq.user?.id;
  const role = String(typedReq.user?.role || "").toLowerCase();

  if (!userId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  if (role !== "pharmacist") {
    throw Object.assign(new Error("Only pharmacists can dispense"), { statusCode: 403 });
  }

  await assertVerifiedPharmacyForUser(userId);
  return userId;
};

const requirePharmacistUser = (req: Request) => {
  const typedReq = req as AuthenticatedRequest;
  const userId = typedReq.user?.id;
  const role = String(typedReq.user?.role || "").toLowerCase();

  if (!userId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  if (role !== "pharmacist") {
    throw Object.assign(new Error("Only pharmacists can access this resource"), { statusCode: 403 });
  }

  return userId;
};

export const getPrescriptionByQrController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacistUser(req);
    const qrToken = validateQrToken(req.params.qrToken);
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacistUserId);
    const verification = await verifyPrescriptionToken(qrToken);
    const data = await fetchPrescriptionByQr(qrToken, String(pharmacy.id), verification.prescriptionId);
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: pharmacistUserId,
      userId: pharmacistUserId,
      action: "prescription_qr_scanned",
      entityType: "prescription",
      entityId: data?.prescription?.id ?? null,
      metadata: {
        pharmacyId: pharmacy.id,
      },
    });
    if (data?.prescription?.dispensedAt) {
      return res.status(409).json({ message: "Prescription has already been dispensed" });
    }
    return res.json(data);
  } catch (error) {
    const typedError = error as { name?: string };
    if (typedError?.name === "TokenExpiredError") {
      return res.status(410).json({ message: "Expired prescription QR" });
    }
    if (typedError?.name === "JsonWebTokenError" || typedError?.name === "NotBeforeError") {
      return res.status(401).json({ message: "Invalid QR code" });
    }
    return handleError(res, error, "Failed to fetch prescription");
  }
};

export const getPrescriptionByIdController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacistUser(req);
    const prescriptionId = validatePrescriptionId(req.params.id);
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacistUserId);
    const data = await fetchPrescriptionById(prescriptionId, String(pharmacy.id));
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to fetch prescription");
  }
};

export const getInventoryController = async (_req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacistUser(_req);
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacistUserId);
    const data = await fetchInventory(pharmacy.id);
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to fetch inventory");
  }
};

export const getPharmacyProfileController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = requirePharmacistUser(req);
    const data = await fetchPharmacyProfileByUserId(pharmacistUserId);
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to fetch pharmacy profile");
  }
};

export const getCategoriesController = async (_req: Request, res: Response) => {
  try {
    await requireVerifiedPharmacistUser(_req);
    const data = await fetchCategories();
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to fetch categories");
  }
};

export const createCategoryController = async (req: Request, res: Response) => {
  try {
    await requireVerifiedPharmacistUser(req);
    const payload = validateCreateLookupPayload(req.body);
    const data = await createCategory(payload);
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to create category");
  }
};

export const getBrandsController = async (_req: Request, res: Response) => {
  try {
    await requireVerifiedPharmacistUser(_req);
    const data = await fetchBrands();
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to fetch brands");
  }
};

export const createBrandController = async (req: Request, res: Response) => {
  try {
    await requireVerifiedPharmacistUser(req);
    const payload = validateCreateLookupPayload(req.body);
    const data = await createBrand(payload);
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to create brand");
  }
};

export const dispensePrescriptionController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacistUser(req);
    const payload = validateDispensePayload(req.body);
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacistUserId);
    const data = await dispensePrescription(payload);
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: pharmacistUserId,
      userId: pharmacistUserId,
      action: "prescription_dispensed",
      entityType: "prescription",
      entityId: payload.prescriptionId ?? null,
      metadata: {
        pharmacyId: pharmacy.id,
        partial: Boolean(data?.is_partial),
      },
    });
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to dispense prescription");
  }
};

export const dispensePrescriptionByIdController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacistUser(req);
    const prescriptionId = validatePrescriptionId(req.params.prescriptionId);
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacistUserId);
    const data = await dispensePrescriptionById({
      prescriptionId,
      pharmacistUserId,
      pharmacyId: pharmacy.id,
    });
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: pharmacistUserId,
      userId: pharmacistUserId,
      action: "prescription_dispensed",
      entityType: "prescription",
      entityId: prescriptionId,
      metadata: {
        pharmacyId: pharmacy.id,
      },
    });
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to dispense prescription");
  }
};

export const createSaleController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacistUser(req);
    const payload = validateSalePayload(req.body);
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacistUserId);
    const data = await createSale({
      ...payload,
      pharmacyId: pharmacy.id,
      pharmacistUserId,
    });
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to create sale");
  }
};

export const createDemandLogController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacistUser(req);
    const payload = validateDemandLogPayload(req.body);
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacistUserId);
    const data = await createDemandLog({
      ...payload,
      pharmacyId: pharmacy.id,
    });
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to create demand log");
  }
};

export const createMedicineController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacistUser(req);
    const payload = validateCreateMedicinePayload(req.body);
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacistUserId);
    const data = await createMedicine(payload, pharmacy.id);
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: pharmacistUserId,
      userId: pharmacistUserId,
      action: "inventory_created",
      entityType: "inventory",
      entityId: data?.medicine?.id ?? null,
      metadata: {
        pharmacyId: pharmacy.id,
        name: payload.name,
      },
    });
    emitInventoryUpdated({
      pharmacyId: pharmacy.id,
      medicineId: data?.medicine?.id ?? null,
      metadata: { kind: "create" },
    });
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to save medicine");
  }
};

export const updateMedicineController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacistUser(req);
    const payload = validateUpdateMedicinePayload(req.params.id, req.body);
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacistUserId);
    const data = await updateMedicine(payload, pharmacy.id);
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: pharmacistUserId,
      userId: pharmacistUserId,
      action: "inventory_updated",
      entityType: "inventory",
      entityId: payload.id,
      metadata: {
        pharmacyId: pharmacy.id,
      },
    });
    emitInventoryUpdated({
      pharmacyId: pharmacy.id,
      medicineId: payload.id,
      metadata: { kind: "update" },
    });
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to update medicine");
  }
};

export const restockMedicineController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacistUser(req);
    const payload = validateRestockMedicinePayload(req.params.id, req.body);
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacistUserId);
    const data = await restockMedicine(payload, pharmacy.id);
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: pharmacistUserId,
      userId: pharmacistUserId,
      action: "inventory_updated",
      entityType: "inventory",
      entityId: payload.id,
      metadata: {
        pharmacyId: pharmacy.id,
        kind: "restock",
        quantity: payload.quantity,
      },
    });
    emitInventoryUpdated({
      pharmacyId: pharmacy.id,
      medicineId: payload.id,
      metadata: {
        kind: "restock",
        quantity: payload.quantity,
      },
    });
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to restock medicine");
  }
};

export const deleteMedicineController = async (req: Request, res: Response) => {
  try {
    const pharmacistUserId = await requireVerifiedPharmacistUser(req);
    const id = validateMedicineId(req.params.id);
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacistUserId);
    const data = await deleteMedicine(id, pharmacy.id);
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: pharmacistUserId,
      userId: pharmacistUserId,
      action: "inventory_deleted",
      entityType: "inventory",
      entityId: id,
      metadata: {
        pharmacyId: pharmacy.id,
      },
    });
    emitInventoryUpdated({
      pharmacyId: pharmacy.id,
      medicineId: id,
      metadata: { kind: "delete" },
    });
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to delete medicine");
  }
};
