import type { RequestHandler, Response } from "express";
import { env } from "../config/env";
import { io } from "../server";
import type { AuthenticatedRequest } from "../types/auth";
import {
  createReceptionistForMedicalCenter,
  getReceptionistPermissions,
  listReceptionistsByMedicalCenter,
  removeReceptionistFromMedicalCenter,
  resendReceptionistInvite,
  type ReceptionistPermissionFlags,
  updateReceptionistStatus,
  updateReceptionistPermissions,
} from "../services/receptionist.service";

type CreateReceptionistBody = {
  name?: string;
  email?: string;
  phone?: string;
};

type UpdateReceptionistStatusBody = {
  status?: string;
};

type UpdateReceptionistPermissionsBody = Partial<
  ReceptionistPermissionFlags & {
    queue_access: boolean;
    appointments: boolean;
    check_in: boolean;
  }
>;

type ReceptionistParams = {
  id: string;
};

type ReceptionistActionRequest<TBody = Record<string, unknown>> = AuthenticatedRequest<TBody> & {
  medicalCenterId: string;
  params: ReceptionistParams;
};

const emitCenterEvent = (medicalCenterId: string, event: string, payload?: Record<string, unknown>) => {
  io.to(`center_${medicalCenterId}`).emit(event, {
    medicalCenterId,
    ...(payload || {}),
  });
};

export const listReceptionists: RequestHandler = async (req, res: Response) => {
  const typedReq = req as AuthenticatedRequest & { medicalCenterId: string };
  try {
    const receptionists = await listReceptionistsByMedicalCenter(typedReq.medicalCenterId);
    return res.status(200).json(receptionists);
  } catch (error: any) {
    return res.status(500).json({
      message: error?.message || "Failed to load receptionists",
    });
  }
};

export const createReceptionist: RequestHandler = async (req, res: Response) => {
  const typedReq = req as AuthenticatedRequest<CreateReceptionistBody> & { medicalCenterId: string };
  try {
    const result = await createReceptionistForMedicalCenter({
      medicalCenterId: typedReq.medicalCenterId,
      name: String(typedReq.body?.name ?? ""),
      email: String(typedReq.body?.email ?? ""),
      phone: typedReq.body?.phone,
      webBaseUrl: env.appWebUrl || env.publicAppUrl || env.receptionistSetupUrl,
      mobileScheme: env.mobileAppScheme,
    });

    emitCenterEvent(typedReq.medicalCenterId, "appointment:update", {
      type: "receptionist_created",
      receptionistId: result.receptionist.id,
    });

    return res.status(201).json(result);
  } catch (error: any) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({
      message: error?.message || "Failed to create receptionist",
    });
  }
};

export const resendReceptionistInviteController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as ReceptionistActionRequest;
  try {
    const result = await resendReceptionistInvite({
      medicalCenterId: typedReq.medicalCenterId,
      receptionistId: typedReq.params.id,
      webBaseUrl: env.appWebUrl || env.publicAppUrl || env.receptionistSetupUrl,
      mobileScheme: env.mobileAppScheme,
    });

    emitCenterEvent(typedReq.medicalCenterId, "appointment:update", {
      type: "receptionist_invite_resent",
      receptionistId: result.receptionist.id,
    });

    return res.status(200).json(result);
  } catch (error: any) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({
      message: error?.message || "Failed to resend receptionist invite",
    });
  }
};

export const updateReceptionistStatusController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as ReceptionistActionRequest<UpdateReceptionistStatusBody>;
  try {
    const result = await updateReceptionistStatus({
      medicalCenterId: typedReq.medicalCenterId,
      receptionistId: typedReq.params.id,
      status: String(typedReq.body?.status ?? ""),
    });

    emitCenterEvent(typedReq.medicalCenterId, "appointment:update", {
      type: "receptionist_status_updated",
      userId: result.user_id,
      status: result.status,
    });

    return res.status(200).json(result);
  } catch (error: any) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({
      message: error?.message || "Failed to update receptionist status",
    });
  }
};

export const getReceptionistPermissionsController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as ReceptionistActionRequest;
  try {
    const result = await getReceptionistPermissions({
      medicalCenterId: typedReq.medicalCenterId,
      receptionistId: typedReq.params.id,
    });

    return res.status(200).json(result);
  } catch (error: any) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({
      message: error?.message || "Failed to load receptionist permissions",
    });
  }
};

export const updateReceptionistPermissionsController: RequestHandler = async (
  req,
  res: Response
) => {
  const typedReq = req as ReceptionistActionRequest<UpdateReceptionistPermissionsBody>;
  try {
    const result = await updateReceptionistPermissions({
      medicalCenterId: typedReq.medicalCenterId,
      receptionistId: typedReq.params.id,
      permissions: {
        can_manage_queue: typedReq.body?.queue_access ?? typedReq.body?.can_manage_queue,
        can_manage_appointments:
          typedReq.body?.appointments ?? typedReq.body?.can_manage_appointments,
        can_check_in: typedReq.body?.check_in ?? typedReq.body?.can_check_in,
        schedule_management: typedReq.body?.schedule_management,
      },
    });

    emitCenterEvent(typedReq.medicalCenterId, "appointment:update", {
      type: "receptionist_permissions_updated",
      userId: result.receptionist.user_id,
    });

    return res.status(200).json(result);
  } catch (error: any) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({
      message: error?.message || "Failed to update receptionist permissions",
    });
  }
};

export const deleteReceptionistController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as ReceptionistActionRequest;
  try {
    const result = await removeReceptionistFromMedicalCenter({
      medicalCenterId: typedReq.medicalCenterId,
      receptionistId: typedReq.params.id,
    });

    emitCenterEvent(typedReq.medicalCenterId, "appointment:update", {
      type: "receptionist_removed",
      userId: result.receptionist.user_id,
    });

    return res.status(200).json(result);
  } catch (error: any) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({
      message: error?.message || "Failed to remove receptionist from clinic",
    });
  }
};
