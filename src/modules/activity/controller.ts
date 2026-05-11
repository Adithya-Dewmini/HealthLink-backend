import type { Response } from "express";
import type { AuthenticatedRequest } from "../../types/auth";
import { formatApiError } from "../../middleware/errorHandler";
import { HttpError, isHttpError } from "../pharmacy/errors";
import { listMyActivityFeed } from "./service";
import { validateActivityQuery } from "./validation";

const handleError = (res: Response, error: unknown, fallbackMessage: string) => {
  if (isHttpError(error)) {
    const formatted = formatApiError(error);
    return res.status(formatted.statusCode).json(formatted.body);
  }

  console.error(fallbackMessage, error);
  const formatted = formatApiError(Object.assign(new Error(fallbackMessage), { statusCode: 500 }));
  return res.status(formatted.statusCode).json(formatted.body);
};

const requireAuthenticatedUser = (req: AuthenticatedRequest) => {
  const userId = req.user?.id;
  if (!userId) {
    throw new HttpError(401, "Unauthorized");
  }
  return Number(userId);
};

export const getMyActivityFeedController = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = requireAuthenticatedUser(req);
    const pagination = validateActivityQuery(req.query as Record<string, unknown>);
    const data = await listMyActivityFeed(userId, pagination);
    return res.status(200).json(data);
  } catch (error) {
    return handleError(res, error, "Failed to load activity feed");
  }
};
