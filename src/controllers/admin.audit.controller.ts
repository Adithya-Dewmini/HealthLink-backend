import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  getAdminAuditLogDetail,
  listAdminAuditLogs,
} from "../services/admin.audit.service";

type HttpError = Error & { statusCode?: number };

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;

  return res.status(statusCode).json({
    message: appError?.message || fallbackMessage,
  });
};

export const listAdminAuditLogsController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const data = await listAdminAuditLogs({
      actorId:
        typeof req.query.actor_id === "string" && req.query.actor_id.trim().length > 0
          ? Number(req.query.actor_id)
          : undefined,
      role: typeof req.query.role === "string" ? req.query.role : undefined,
      action: typeof req.query.action === "string" ? req.query.action : undefined,
      entityType: typeof req.query.entity_type === "string" ? req.query.entity_type : undefined,
      startDate: typeof req.query.start_date === "string" ? req.query.start_date : undefined,
      endDate: typeof req.query.end_date === "string" ? req.query.end_date : undefined,
      page:
        typeof req.query.page === "string" && req.query.page.trim().length > 0
          ? Number(req.query.page)
          : undefined,
      pageSize:
        typeof req.query.pageSize === "string" && req.query.pageSize.trim().length > 0
          ? Number(req.query.pageSize)
          : typeof req.query.page_size === "string" && req.query.page_size.trim().length > 0
            ? Number(req.query.page_size)
            : undefined,
    });

    return res.status(200).json(data);
  } catch (error) {
    console.error("Admin audit logs error:", error);
    return handleControllerError(res, error, "Failed to load audit logs");
  }
};

export const getAdminAuditLogDetailController = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const data = await getAdminAuditLogDetail(req.params.id);
    return res.status(200).json(data);
  } catch (error) {
    console.error("Admin audit log detail error:", error);
    return handleControllerError(res, error, "Failed to load audit log detail");
  }
};
