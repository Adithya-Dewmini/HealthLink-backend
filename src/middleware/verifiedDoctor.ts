import type { RequestHandler } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { assertVerifiedDoctorProfileOnlyByUserId } from "../services/verification.service";

export const requireVerifiedDoctor: RequestHandler = async (req, res, next) => {
  const typedReq = req as AuthenticatedRequest;
  const role = String(typedReq.user?.role || "").toLowerCase();
  const userId = typedReq.user?.id;

  if (role !== "doctor") {
    return res.status(403).json({ message: "Doctor access required" });
  }

  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    await assertVerifiedDoctorProfileOnlyByUserId(userId);
    return next();
  } catch (error) {
    const appError = error as Error & { statusCode?: number };
    return res.status(Number(appError.statusCode) || 403).json({
      message: appError.message || "Doctor is not verified",
    });
  }
};
