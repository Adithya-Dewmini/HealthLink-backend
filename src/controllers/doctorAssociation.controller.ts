import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  acceptDoctorClinicInvite,
  acceptDoctorInvite,
  createDoctorJoinRequest,
  listDoctorClinics,
  rejectDoctorClinicInvite,
} from "../services/doctorAssociation.service";

type AcceptDoctorInviteBody = {
  token?: string;
};

type DoctorJoinRequestBody = {
  medicalCenterId?: string;
};

const getDoctorUserId = (req: AuthenticatedRequest) => {
  if (!req.user?.id) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  if (String(req.user.role || "").toLowerCase() !== "doctor") {
    throw Object.assign(new Error("Only doctors can access this resource"), { statusCode: 403 });
  }

  return Number(req.user.id);
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as Error & { statusCode?: number };
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
};

export const acceptDoctorInviteController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as AuthenticatedRequest<AcceptDoctorInviteBody>;
  try {
    const result = await acceptDoctorInvite({
      doctorUserId: getDoctorUserId(typedReq),
      token: String(typedReq.body?.token ?? ""),
    });

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to accept doctor invite");
  }
};

export const requestToJoinMedicalCenterController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as AuthenticatedRequest<DoctorJoinRequestBody>;
  try {
    const result = await createDoctorJoinRequest({
      doctorUserId: getDoctorUserId(typedReq),
      medicalCenterId: String(typedReq.body?.medicalCenterId ?? ""),
    });

    return res.status(201).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to submit doctor join request");
  }
};

export const getDoctorClinicsController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as AuthenticatedRequest;

  try {
    const result = await listDoctorClinics(getDoctorUserId(typedReq));
    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to fetch doctor clinics");
  }
};

export const acceptDoctorClinicInviteController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as AuthenticatedRequest;

  try {
    const result = await acceptDoctorClinicInvite({
      doctorUserId: getDoctorUserId(typedReq),
      relationshipId: String(typedReq.params.id ?? ""),
    });

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to accept clinic invitation");
  }
};

export const rejectDoctorClinicInviteController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as AuthenticatedRequest;

  try {
    const result = await rejectDoctorClinicInvite({
      doctorUserId: getDoctorUserId(typedReq),
      relationshipId: String(typedReq.params.id ?? ""),
    });

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to reject clinic invitation");
  }
};
