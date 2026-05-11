import type { NextFunction, Response } from "express";
import pool from "../config/db";
import type { AuthenticatedRequest } from "../types/auth";
import {
  getReceptionistPermissionsByUserId,
  toReceptionistPermissionContract,
  type ReceptionistPermissionContract,
} from "../services/receptionistPermissions.service";
import { assertApprovedMedicalCenterForUser } from "../services/verification.service";

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

export const requireMedicalCenterScope = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const medicalCenterId = getRequestMedicalCenterId(req);

  if (!medicalCenterId) {
    return res.status(403).json({ message: "Medical center scope is missing" });
  }

  req.medicalCenterId = medicalCenterId;
  next();
};

export const requireMedicalCenterAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const role = String(req.user?.role || "").toLowerCase();
  const medicalCenterId = req.medicalCenterId || getRequestMedicalCenterId(req);

  if (role !== "medical_center_admin") {
    return res.status(403).json({ message: "Medical center admin access required" });
  }

  if (!medicalCenterId) {
    return res.status(403).json({ message: "Medical center scope is missing" });
  }

  req.medicalCenterId = medicalCenterId;
  next();
};

const RECEPTIONIST_PERMISSION_MESSAGES: Record<keyof ReceptionistPermissionContract, string> = {
  queue_access: "Queue access permission required",
  appointments: "Appointments permission required",
  check_in: "Check-in permission required",
  schedule_management: "You do not have permission to manage doctor sessions.",
};

export const requireReceptionistPermission =
  (permissionKey: keyof ReceptionistPermissionContract) =>
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const role = String(req.user?.role || "").toLowerCase();
      const medicalCenterId = req.medicalCenterId || getRequestMedicalCenterId(req);
      const userId = Number(req.user?.id);

      if (role === "medical_center_admin") {
        if (!medicalCenterId) {
          return res.status(403).json({ message: "Medical center scope is missing" });
        }
        req.medicalCenterId = medicalCenterId;
        return next();
      }

      if (role !== "receptionist") {
        return res.status(403).json({ message: `${RECEPTIONIST_PERMISSION_MESSAGES[permissionKey]}` });
      }

      if (!Number.isFinite(userId) || userId <= 0 || !medicalCenterId) {
        return res.status(403).json({ message: "Medical center access denied" });
      }

      const permissions = toReceptionistPermissionContract(
        await getReceptionistPermissionsByUserId(userId, medicalCenterId)
      );
      if (!permissions[permissionKey]) {
        return res.status(403).json({ message: RECEPTIONIST_PERMISSION_MESSAGES[permissionKey] });
      }

      req.medicalCenterId = medicalCenterId;
      return next();
    } catch (error) {
      console.error("Receptionist permission check failed:", error);
      return res.status(500).json({ message: "Failed to validate receptionist permissions" });
    }
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

      await assertApprovedMedicalCenterForUser(userId);
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

    await assertApprovedMedicalCenterForUser(userId);
    return next();
  } catch (error) {
    console.error("Medical center active-user check failed:", error);
    return res.status(500).json({ message: "Failed to validate center access" });
  }
};
