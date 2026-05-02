import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { getMeContext } from "../services/reception.service";

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
    const role = String(typedReq.user?.role || "");

    if (!userId || !role) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const context = await getMeContext(userId, role);
    return res.status(200).json(context);
  } catch (error) {
    return handleError(res, error, "Failed to load user context");
  }
};
