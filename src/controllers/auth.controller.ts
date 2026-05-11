import type { Request, Response } from "express";
import {
  createForgotPasswordReset,
  loginUserWithPassword,
  resetPasswordFromToken,
  setPasswordFromToken,
  validatePasswordResetToken,
} from "../services/auth.service";
import { createAuditLog, getAuditRequestContext } from "../services/audit.service";
import type {
  AuthenticatedRequest,
  LoginRequestBody,
  ResetPasswordRequestBody,
  SetPasswordRequestBody,
} from "../types/auth";

type HttpError = Error & { statusCode?: number };
type ForgotPasswordRequestBody = {
  email?: string;
};
type ValidateResetTokenRequestBody = {
  token?: string;
};

export const loginUser = async (req: Request<never, unknown, LoginRequestBody>, res: Response) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const expoPushToken =
      typeof req.body?.expoPushToken === "string" ? req.body.expoPushToken : undefined;

    const result = await loginUserWithPassword({
      email,
      password,
      expoPushToken,
    });

    await createAuditLog({
      ...getAuditRequestContext(req),
      actorUserId: result.user?.id ?? null,
      actorRole: result.user?.role ?? null,
      userId: result.user?.id ?? null,
      action: "login",
      entityType: "user",
      entityId: result.user?.id ?? null,
      metadata: {
        email,
      },
    });

    return res.status(200).json(result);
  } catch (error: unknown) {
    const appError = error as HttpError;
    const statusCode = Number(appError?.statusCode) || 500;
    return res.status(statusCode).json({
      message: appError?.message || "Failed to login",
    });
  }
};

export const logoutUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await createAuditLog({
      ...getAuditRequestContext(req),
      action: "logout",
      entityType: "user",
      entityId: req.user?.id ?? null,
      metadata: {
        source: "client_logout",
      },
    });

    return res.status(200).json({ success: true, message: "Logged out successfully" });
  } catch (error: unknown) {
    const appError = error as HttpError;
    const statusCode = Number(appError?.statusCode) || 500;
    return res.status(statusCode).json({
      message: appError?.message || "Failed to logout",
    });
  }
};

export const setPassword = async (
  req: Request<never, unknown, SetPasswordRequestBody>,
  res: Response
) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    const result = await setPasswordFromToken({
      token,
      password,
    });

    return res.status(200).json(result);
  } catch (error: unknown) {
    const appError = error as HttpError;
    const statusCode = Number(appError?.statusCode) || 500;
    return res.status(statusCode).json({
      message: appError?.message || "Failed to set password",
    });
  }
};

export const forgotPassword = async (
  req: Request<never, unknown, ForgotPasswordRequestBody>,
  res: Response
) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const result = await createForgotPasswordReset({ email });
    return res.status(200).json(result);
  } catch (error: unknown) {
    const appError = error as HttpError;
    const statusCode = Number(appError?.statusCode) || 500;
    return res.status(statusCode).json({
      message: appError?.message || "Failed to create password reset request",
    });
  }
};

export const resetPassword = async (
  req: Request<never, unknown, ResetPasswordRequestBody>,
  res: Response
) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    const result = await resetPasswordFromToken({
      token,
      password,
    });

    return res.status(200).json(result);
  } catch (error: unknown) {
    const appError = error as HttpError;
    const statusCode = Number(appError?.statusCode) || 500;
    return res.status(statusCode).json({
      message: appError?.message || "Failed to reset password",
    });
  }
};

export const validateResetToken = async (
  req: Request<never, unknown, ValidateResetTokenRequestBody>,
  res: Response
) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const result = await validatePasswordResetToken({ token });
    return res.status(200).json(result);
  } catch (error: unknown) {
    const appError = error as HttpError;
    const statusCode = Number(appError?.statusCode) || 500;
    return res.status(statusCode).json({
      message: appError?.message || "Failed to validate reset token",
    });
  }
};
