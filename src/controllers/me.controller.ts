import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { getAuthContextUserById } from "../services/auth.service";

const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as Error & { statusCode?: number };
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
};

export const getMeContextController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as AuthenticatedRequest;
  try {
    const userId = Number(typedReq.user?.id);

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const context = await getAuthContextUserById(userId);

    return res.status(200).json({
      role: context.user.role,
      user: context.user,
      clinicId: context.medicalCenterId,
      medicalCenterId: context.medicalCenterId,
      verificationStatus: context.user.verification_status ?? null,
      verificationNotes: context.user.verification_notes ?? null,
      permissions: context.receptionistPermissions ?? null,
    });
  } catch (error) {
    return handleError(res, error, "Failed to load user context");
  }
};
