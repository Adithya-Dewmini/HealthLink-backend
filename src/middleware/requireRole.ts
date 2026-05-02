import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/auth";

export const requireRole =
  (...allowedRoles: string[]) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const role = String(req.user?.role || "")
      .trim()
      .toLowerCase();

    if (!role) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!allowedRoles.map((value) => value.trim().toLowerCase()).includes(role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    next();
  };
