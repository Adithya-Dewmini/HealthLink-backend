import type { Request, Response } from "express";
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
  validateOptionalPharmacyId,
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

export const getPrescriptionByQrController = async (req: Request, res: Response) => {
  try {
    const qrToken = validateQrToken(req.params.qrToken);
    const pharmacyId = validateOptionalPharmacyId(req.query.pharmacy_id);
    const data = await fetchPrescriptionByQr(qrToken, pharmacyId);
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to fetch prescription");
  }
};

export const getPrescriptionByIdController = async (req: Request, res: Response) => {
  try {
    const prescriptionId = validatePrescriptionId(req.params.id);
    const data = await fetchPrescriptionById(prescriptionId);
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to fetch prescription");
  }
};

export const getInventoryController = async (_req: Request, res: Response) => {
  try {
    const data = await fetchInventory();
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to fetch inventory");
  }
};

export const getCategoriesController = async (_req: Request, res: Response) => {
  try {
    const data = await fetchCategories();
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to fetch categories");
  }
};

export const createCategoryController = async (req: Request, res: Response) => {
  try {
    const payload = validateCreateLookupPayload(req.body);
    const data = await createCategory(payload);
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to create category");
  }
};

export const getBrandsController = async (_req: Request, res: Response) => {
  try {
    const data = await fetchBrands();
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to fetch brands");
  }
};

export const createBrandController = async (req: Request, res: Response) => {
  try {
    const payload = validateCreateLookupPayload(req.body);
    const data = await createBrand(payload);
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to create brand");
  }
};

export const dispensePrescriptionController = async (req: Request, res: Response) => {
  try {
    const payload = validateDispensePayload(req.body);
    const data = await dispensePrescription(payload);
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to dispense prescription");
  }
};

export const dispensePrescriptionByIdController = async (req: Request, res: Response) => {
  try {
    const prescriptionId = validatePrescriptionId(req.params.prescriptionId);
    const pharmacistUserId = (req as any)?.user?.id ?? null;
    const data = await dispensePrescriptionById({ prescriptionId, pharmacistUserId });
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to dispense prescription");
  }
};

export const createSaleController = async (req: Request, res: Response) => {
  try {
    const payload = validateSalePayload(req.body);
    const data = await createSale(payload);
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to create sale");
  }
};

export const createDemandLogController = async (req: Request, res: Response) => {
  try {
    const payload = validateDemandLogPayload(req.body);
    const data = await createDemandLog(payload);
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to create demand log");
  }
};

export const createMedicineController = async (req: Request, res: Response) => {
  try {
    console.log("Create medicine request body:", req.body);
    const payload = validateCreateMedicinePayload(req.body);
    const data = await createMedicine(payload);
    console.log("Inserted medicine ID:", data?.medicine?.id);
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to save medicine");
  }
};

export const updateMedicineController = async (req: Request, res: Response) => {
  try {
    const payload = validateUpdateMedicinePayload(req.params.id, req.body);
    const data = await updateMedicine(payload);
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to update medicine");
  }
};

export const restockMedicineController = async (req: Request, res: Response) => {
  try {
    const payload = validateRestockMedicinePayload(req.params.id, req.body);
    const data = await restockMedicine(payload);
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to restock medicine");
  }
};

export const deleteMedicineController = async (req: Request, res: Response) => {
  try {
    const id = validateMedicineId(req.params.id);
    const data = await deleteMedicine(id);
    return res.json(data);
  } catch (error) {
    return handleError(res, error, "Failed to delete medicine");
  }
};
