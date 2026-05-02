import type { RequestHandler, Response } from "express";
import { env } from "../config/env";
import { io } from "../server";
import type { AuthenticatedRequest } from "../types/auth";
import {
  inviteDoctorToMedicalCenter,
  listDoctorJoinRequestsForCenter,
  listMedicalCenterDoctorsWithInvites,
  removeDoctorFromMedicalCenter,
  resendDoctorInvite,
  reviewDoctorJoinRequest,
  updateDoctorRelationshipStatus,
} from "../services/doctorAssociation.service";

type DoctorInviteBody = {
  email?: string;
  doctorId?: number;
};

type DoctorRequestActionBody = {
  action?: "APPROVE" | "REJECT";
};

type DoctorRelationshipStatusBody = {
  status?: "ACTIVE" | "INACTIVE";
};

type RouteParams = {
  id: string;
};

type CenterRequest<TBody = Record<string, unknown>> = AuthenticatedRequest<TBody> & {
  medicalCenterId: string;
};

type CenterActionRequest<TBody = Record<string, unknown>> = CenterRequest<TBody> & {
  params: RouteParams;
};

const emitCenterEvent = (medicalCenterId: string, event: string, payload?: Record<string, unknown>) => {
  io.to(`center_${medicalCenterId}`).emit(event, {
    medicalCenterId,
    ...(payload || {}),
  });
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as Error & { statusCode?: number };
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
};

export const listMedicalCenterDoctorAssignmentsController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as CenterRequest;
  try {
    const doctors = await listMedicalCenterDoctorsWithInvites(typedReq.medicalCenterId);
    return res.status(200).json(doctors);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load medical center doctors");
  }
};

export const inviteDoctorToMedicalCenterController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as CenterRequest<DoctorInviteBody>;
  try {
    const result = await inviteDoctorToMedicalCenter({
      medicalCenterId: typedReq.medicalCenterId,
      email: String(typedReq.body?.email ?? ""),
      doctorId: typedReq.body?.doctorId ? Number(typedReq.body.doctorId) : undefined,
      invitedByUserId: Number(typedReq.user?.id),
      webBaseUrl: env.appWebUrl || env.publicAppUrl,
    });

    emitCenterEvent(typedReq.medicalCenterId, "doctor:status", {
      type: "doctor_invited",
      email: result.invite.email,
      inviteId: result.invite.id,
    });

    return res.status(201).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to invite doctor");
  }
};

export const resendDoctorInviteController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as CenterActionRequest;
  try {
    const result = await resendDoctorInvite({
      medicalCenterId: typedReq.medicalCenterId,
      inviteId: typedReq.params.id,
      requestedByUserId: Number(typedReq.user?.id),
      webBaseUrl: env.appWebUrl || env.publicAppUrl,
    });

    emitCenterEvent(typedReq.medicalCenterId, "doctor:status", {
      type: "doctor_invite_resent",
      inviteId: result.invite.id,
      email: result.invite.email,
    });

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to resend doctor invite");
  }
};

export const listDoctorJoinRequestsController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as CenterRequest;
  try {
    const requests = await listDoctorJoinRequestsForCenter(typedReq.medicalCenterId);
    return res.status(200).json(requests);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load doctor join requests");
  }
};

export const reviewDoctorJoinRequestController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as CenterActionRequest<DoctorRequestActionBody>;
  try {
    const result = await reviewDoctorJoinRequest({
      requestId: typedReq.params.id,
      medicalCenterId: typedReq.medicalCenterId,
      action: String(typedReq.body?.action ?? "").toUpperCase() as "APPROVE" | "REJECT",
      reviewedByUserId: Number(typedReq.user?.id),
    });

    emitCenterEvent(typedReq.medicalCenterId, "doctor:status", {
      type: "doctor_join_request_reviewed",
      requestId: result.request.id,
      status: result.request.status,
    });

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to review doctor join request");
  }
};

export const updateDoctorRelationshipStatusController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as CenterActionRequest<DoctorRelationshipStatusBody>;
  try {
    const result = await updateDoctorRelationshipStatus({
      medicalCenterId: typedReq.medicalCenterId,
      relationshipId: typedReq.params.id,
      status: String(typedReq.body?.status ?? "").toUpperCase() as "ACTIVE" | "INACTIVE",
      updatedByUserId: Number(typedReq.user?.id),
    });

    emitCenterEvent(typedReq.medicalCenterId, "doctor:status", {
      type: "doctor_relationship_status_updated",
      relationshipId: typedReq.params.id,
      status: result.status,
    });

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to update doctor relationship status");
  }
};

export const removeDoctorFromMedicalCenterController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as CenterActionRequest;
  try {
    const result = await removeDoctorFromMedicalCenter({
      medicalCenterId: typedReq.medicalCenterId,
      relationshipId: typedReq.params.id,
      removedByUserId: Number(typedReq.user?.id),
    });

    emitCenterEvent(typedReq.medicalCenterId, "doctor:status", {
      type: "doctor_relationship_removed",
      relationshipId: typedReq.params.id,
    });

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to remove doctor from medical center");
  }
};
