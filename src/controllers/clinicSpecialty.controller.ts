import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  createClinicSpecialty,
  deleteClinicSpecialty,
  listClinicSpecialties,
  updateClinicSpecialty,
} from "../services/clinicSpecialty.service";

type SpecialtyBody = {
  name?: string;
};

type CenterRequest<TBody = Record<string, unknown>> = AuthenticatedRequest<TBody> & {
  medicalCenterId: string;
  params: {
    id: string;
  };
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as Error & { statusCode?: number };
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
};

export const listClinicSpecialtiesController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as CenterRequest;
  try {
    const result = await listClinicSpecialties(typedReq.medicalCenterId);
    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load specialties");
  }
};

export const createClinicSpecialtyController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as CenterRequest<SpecialtyBody>;
  try {
    const result = await createClinicSpecialty({
      medicalCenterId: typedReq.medicalCenterId,
      name: String(typedReq.body?.name || ""),
    });
    return res.status(201).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to create specialty");
  }
};

export const updateClinicSpecialtyController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as CenterRequest<SpecialtyBody>;
  try {
    const result = await updateClinicSpecialty({
      medicalCenterId: typedReq.medicalCenterId,
      specialtyId: typedReq.params.id,
      name: String(typedReq.body?.name || ""),
    });
    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to update specialty");
  }
};

export const deleteClinicSpecialtyController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as CenterRequest;
  try {
    const result = await deleteClinicSpecialty({
      medicalCenterId: typedReq.medicalCenterId,
      specialtyId: typedReq.params.id,
    });
    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to delete specialty");
  }
};
