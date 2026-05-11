import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../../types/auth";
import { formatApiError } from "../../middleware/errorHandler";
import { HttpError, isHttpError } from "../pharmacy/errors";
import { addCartItem, deleteCartItem, getCart, updateCartItem } from "./service";
import {
  validateCartItemPayload,
  validateCartItemRouteId,
  validateCartItemUpdatePayload,
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

const requirePatientUser = (req: Request) => {
  const typedReq = req as AuthenticatedRequest;
  const userId = typedReq.user?.id;
  const role = String(typedReq.user?.role || "").toLowerCase();

  if (!userId) {
    throw new HttpError(401, "Unauthorized");
  }

  if (role !== "patient" && role !== "user") {
    throw new HttpError(403, "Only patients can manage carts");
  }

  return Number(userId);
};

export const getCartController = async (req: Request, res: Response) => {
  try {
    const patientId = requirePatientUser(req);
    const data = await getCart(patientId);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to load cart");
  }
};

export const addCartItemController = async (req: Request, res: Response) => {
  try {
    const patientId = requirePatientUser(req);
    const payload = validateCartItemPayload(req.body);
    const data = await addCartItem(patientId, payload);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to update cart");
  }
};

export const updateCartItemController = async (req: Request, res: Response) => {
  try {
    const patientId = requirePatientUser(req);
    const payload = validateCartItemUpdatePayload(req.params.id, req.body);
    const data = await updateCartItem(patientId, payload);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to update cart item");
  }
};

export const deleteCartItemController = async (req: Request, res: Response) => {
  try {
    const patientId = requirePatientUser(req);
    const cartItemId = validateCartItemRouteId(req.params.id);
    const data = await deleteCartItem(patientId, cartItemId);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to remove cart item");
  }
};
