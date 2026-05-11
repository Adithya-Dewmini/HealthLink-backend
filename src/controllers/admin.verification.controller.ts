import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  addVerificationEntityNote,
  getVerificationEntityDetail,
  listVerificationEntities,
  reviewVerificationEntity,
} from "../services/verification.service";

type HttpError = Error & { statusCode?: number };

type ReviewBody = {
  note?: string | null;
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;
  return res.status(statusCode).json({
    message: appError?.message || fallbackMessage,
  });
};

export const listVerificationsController = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await listVerificationEntities({
      entityType: typeof req.query.type === "string" ? req.query.type : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      page: typeof req.query.page === "string" ? Number(req.query.page) : undefined,
      pageSize:
        typeof req.query.pageSize === "string"
          ? Number(req.query.pageSize)
          : typeof req.query.page_size === "string"
            ? Number(req.query.page_size)
            : undefined,
    });
    return res.status(200).json(data);
  } catch (error) {
    console.error("List verifications error:", error);
    return handleControllerError(res, error, "Failed to load verifications");
  }
};

export const getVerificationDetailController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const detail = await getVerificationEntityDetail(req.params.type, req.params.id);
    return res.status(200).json(detail);
  } catch (error) {
    console.error("Verification detail error:", error);
    return handleControllerError(res, error, "Failed to load verification detail");
  }
};

export const addVerificationNoteController = async (
  req: AuthenticatedRequest<ReviewBody>,
  res: Response
) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const detail = await addVerificationEntityNote({
      entityType: req.params.type,
      entityId: req.params.id,
      note: req.body?.note ?? "",
      reviewedByUserId: req.user.id,
    });

    return res.status(200).json(detail);
  } catch (error) {
    console.error("Verification note error:", error);
    return handleControllerError(res, error, "Failed to save verification note");
  }
};

const reviewVerification =
  (status: "approved" | "rejected" | "suspended") =>
  async (req: AuthenticatedRequest<ReviewBody>, res: Response) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const detail = await reviewVerificationEntity({
        entityType: req.params.type,
        entityId: req.params.id,
        status,
        note: req.body?.note ?? null,
        reviewedByUserId: req.user.id,
      });

      return res.status(200).json(detail);
    } catch (error) {
      console.error(`Verification ${status} error:`, error);
      return handleControllerError(
        res,
        error,
        status === "approved" ? "Failed to approve verification" : "Failed to reject verification"
      );
    }
  };

export const approveVerificationController = reviewVerification("approved");
export const rejectVerificationController = reviewVerification("rejected");
export const suspendVerificationController = reviewVerification("suspended");
