import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { extractBearerToken, verifyAuthToken } from "../utils/security";

export default function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    req.user = verifyAuthToken(token);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
