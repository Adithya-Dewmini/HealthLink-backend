import type { NextFunction, Request, Response } from "express";

type AppError = Error & {
  statusCode?: number;
  code?: string;
  details?: unknown;
};

export const formatApiError = (
  error: unknown,
  fallbackMessage = "Internal server error"
) => {
  const typed = error as AppError;
  return {
    statusCode: Number(typed?.statusCode) || 500,
    body: {
      success: false,
      message: typed?.message || fallbackMessage,
      error: {
        code: typed?.code || (Number(typed?.statusCode) || 500) >= 500 ? "internal_error" : "request_error",
        message: typed?.message || fallbackMessage,
        details: typed?.details,
      },
    },
  };
};

export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  const formatted = formatApiError(error);
  if (formatted.statusCode >= 500) {
    console.error("Unhandled API error:", error);
  }
  return res.status(formatted.statusCode).json(formatted.body);
};
