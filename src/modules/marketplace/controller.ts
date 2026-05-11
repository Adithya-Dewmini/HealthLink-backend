import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../../types/auth";
import { formatApiError } from "../../middleware/errorHandler";
import { assertVerifiedPharmacyForUser } from "../../services/verification.service";
import { fetchPharmacyProfileByUserId } from "../pharmacy/service";
import { HttpError, isHttpError } from "../pharmacy/errors";
import {
  createMarketplaceProduct,
  getMarketplaceProductDetails,
  getMarketplaceStoreByPharmacyId,
  searchMarketplaceProducts,
  updateMarketplaceProduct,
  updateMarketplaceProductVisibility,
} from "./service";
import {
  validateCreateMarketplaceProductPayload,
  validateMarketplaceRouteId,
  validateMarketplaceSearchQuery,
  validateMarketplaceVisibilityPayload,
  validateUpdateMarketplaceProductPayload,
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

const requireVerifiedPharmacist = async (req: Request) => {
  const typedReq = req as AuthenticatedRequest;
  const userId = typedReq.user?.id;
  const role = String(typedReq.user?.role || "").trim().toLowerCase();

  if (!userId) {
    throw new HttpError(401, "Unauthorized");
  }

  if (role !== "pharmacist") {
    throw new HttpError(403, "Only pharmacists can manage marketplace products");
  }

  await assertVerifiedPharmacyForUser(userId);
  return fetchPharmacyProfileByUserId(userId);
};

export const getMarketplaceStoreController = async (req: Request, res: Response) => {
  try {
    const pharmacyId = validateMarketplaceRouteId(req.params.pharmacyId, "pharmacy id");
    const data = await getMarketplaceStoreByPharmacyId(pharmacyId);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to load marketplace storefront");
  }
};

export const searchMarketplaceProductsController = async (req: Request, res: Response) => {
  try {
    const query = validateMarketplaceSearchQuery(req.query.q);
    const data = await searchMarketplaceProducts(query);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to search marketplace products");
  }
};

export const getMarketplaceProductDetailsController = async (req: Request, res: Response) => {
  try {
    const productId = validateMarketplaceRouteId(req.params.id, "marketplace product id");
    const data = await getMarketplaceProductDetails(productId);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to load marketplace product");
  }
};

export const createMarketplaceProductController = async (req: Request, res: Response) => {
  try {
    const pharmacy = await requireVerifiedPharmacist(req);
    const payload = validateCreateMarketplaceProductPayload(req.body);
    const data = await createMarketplaceProduct(pharmacy.id, payload);
    return res.status(201).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to publish marketplace product");
  }
};

export const updateMarketplaceProductController = async (req: Request, res: Response) => {
  try {
    const pharmacy = await requireVerifiedPharmacist(req);
    const payload = validateUpdateMarketplaceProductPayload(req.params.id, req.body);
    const data = await updateMarketplaceProduct(pharmacy.id, payload);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to update marketplace product");
  }
};

export const updateMarketplaceProductVisibilityController = async (
  req: Request,
  res: Response
) => {
  try {
    const pharmacy = await requireVerifiedPharmacist(req);
    const payload = validateMarketplaceVisibilityPayload(req.params.id, req.body);
    const data = await updateMarketplaceProductVisibility(pharmacy.id, payload);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to update marketplace product visibility");
  }
};
