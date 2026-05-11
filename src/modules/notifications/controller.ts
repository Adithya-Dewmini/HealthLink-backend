import type { Response } from "express";
import type { AuthenticatedRequest } from "../../types/auth";
import { formatApiError } from "../../middleware/errorHandler";
import { createAuditLog, getAuditRequestContext } from "../../services/audit.service";
import { HttpError } from "../pharmacy/errors";
import {
  listNotificationsForUser,
  markNotificationRead,
  registerPushToken,
} from "../../services/notification.service";
import {
  validateNotificationRouteId,
  validateNotificationQuery,
  validateRegisterPushTokenPayload,
} from "./validation";

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const typed = error as Error & { statusCode?: number };
  const formatted = formatApiError(
    Object.assign(new Error(typed?.message || fallbackMessage), {
      statusCode: Number(typed?.statusCode) || 500,
    })
  );
  return res.status(formatted.statusCode).json(formatted.body);
};

const requireAuthenticatedUser = (req: AuthenticatedRequest) => {
  const userId = req.user?.id;
  if (!userId) {
    throw new HttpError(401, "Unauthorized");
  }
  return {
    userId: Number(userId),
    role: typeof req.user?.role === "string" ? req.user.role : null,
  };
};

export const listNotificationsController = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { userId } = requireAuthenticatedUser(req);
    const pagination = validateNotificationQuery(req.query as Record<string, unknown>);
    const data = await listNotificationsForUser(userId, pagination);
    return res.status(200).json(data);
  } catch (error) {
    return handleControllerError(res, error, "Failed to load notifications");
  }
};

export const markNotificationReadController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { userId } = requireAuthenticatedUser(req);
    const notificationId = validateNotificationRouteId(req.params.id);
    const data = await markNotificationRead(userId, notificationId);
    return res.status(200).json(data);
  } catch (error) {
    return handleControllerError(res, error, "Failed to update notification");
  }
};

export const registerPushTokenController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { userId, role } = requireAuthenticatedUser(req);
    const payload = validateRegisterPushTokenPayload(req.body);
    const data = await registerPushToken({
      userId,
      role,
      ...payload,
    });
    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: userId,
      actorRole: role,
      userId,
      action: "notification_token_registered",
      entityType: "push_token",
      entityId: data.id,
      metadata: {
        devicePlatform: payload.devicePlatform,
        deviceModel: payload.deviceModel,
      },
    });
    return res.status(200).json({
      message: "Push token registered successfully",
      token: data,
    });
  } catch (error) {
    return handleControllerError(res, error, "Failed to register push token");
  }
};
