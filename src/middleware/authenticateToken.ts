import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { extractBearerToken, verifyAuthToken } from "../utils/security";

export const authenticateToken = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({ message: "Access token missing" });
  }

  try {
    req.user = verifyAuthToken(token);
    return next();
  } catch {
    return res.status(403).json({ message: "Invalid token" });
  }
};
