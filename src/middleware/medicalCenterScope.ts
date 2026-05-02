import type { NextFunction, Response } from "express";
import pool from "../config/db";
import type { AuthenticatedRequest } from "../types/auth";

type CenterStatusRow = { status: string };

export const getRequestMedicalCenterId = (
  req: Pick<AuthenticatedRequest, "user">
): string | null => {
  const centers = Array.isArray(req.user?.centers) ? req.user.centers : [];
  const centerFromArray =
    centers.find(
      (center) => typeof center?.id === "string" && String(center.id).trim().length > 0
    )?.id ?? null;

  const value =
    centerFromArray ??
    req.user?.medicalCenterId ??
    null;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

export const requireMedicalCenterAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const role = String(req.user?.role || "").toLowerCase();
  const medicalCenterId = getRequestMedicalCenterId(req);

  if (role !== "medical_center_admin") {
    return res.status(403).json({ message: "Medical center admin access required" });
  }

  if (!medicalCenterId) {
    return res.status(403).json({ message: "Medical center scope is missing" });
  }

  req.medicalCenterId = medicalCenterId;
  next();
};

export const checkActiveUserInCenter = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = Number(req.user?.id);
    const medicalCenterId = req.medicalCenterId || getRequestMedicalCenterId(req);
    const role = String(req.user?.role || "").toLowerCase();

    if (!Number.isFinite(userId) || userId <= 0 || !medicalCenterId) {
      return res.status(403).json({ message: "Medical center access denied" });
    }

    if (role === "medical_center_admin") {
      const adminResult = await pool.query(
        `
          SELECT 1
          FROM medical_center_admins
          WHERE user_id = $1 AND medical_center_id = $2
          LIMIT 1
        `,
        [userId, medicalCenterId]
      );

      if (adminResult.rows.length === 0) {
        return res.status(403).json({ message: "Medical center access denied" });
      }

      return next();
    }

    const centerUserResult = await pool.query<CenterStatusRow>(
      `
        SELECT status
        FROM medical_center_users
        WHERE user_id = $1
          AND medical_center_id = $2
        LIMIT 1
      `,
      [userId, medicalCenterId]
    );

    if (centerUserResult.rows.length === 0 || centerUserResult.rows[0]?.status !== "ACTIVE") {
      return res.status(403).json({ message: "User account is inactive in this center" });
    }

    return next();
  } catch (error) {
    console.error("Medical center active-user check failed:", error);
    return res.status(500).json({ message: "Failed to validate center access" });
  }
};
