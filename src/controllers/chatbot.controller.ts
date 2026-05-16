import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { handleAssistantMessage } from "../services/assistant/assistant.orchestrator";

type HttpError = Error & { statusCode?: number };

const requirePatientLikeUser = (req: AuthenticatedRequest) => {
  const role = String(req.user?.role || "").toLowerCase();
  const patientId = req.user?.id;

  if (role !== "patient" && role !== "user") {
    throw Object.assign(new Error("Only patients can access the assistant"), { statusCode: 403 });
  }

  if (!patientId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  return Number(patientId);
};

export const sendPatientChatbotMessage = async (
  req: AuthenticatedRequest<{
    message?: string;
    conversationId?: string;
    language?: "en" | "si" | "ta";
    actionPayload?: Record<string, unknown>;
  }>,
  res: Response
) => {
  try {
    const patientId = requirePatientLikeUser(req);
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const conversationId =
      typeof req.body?.conversationId === "string" && req.body.conversationId.trim()
        ? req.body.conversationId.trim()
        : undefined;
    const language =
      req.body?.language === "en" || req.body?.language === "si" || req.body?.language === "ta"
        ? req.body.language
        : undefined;
    const actionPayload =
      req.body?.actionPayload && typeof req.body.actionPayload === "object" && !Array.isArray(req.body.actionPayload)
        ? req.body.actionPayload
        : undefined;

    if (!message) {
      return res.status(400).json({ message: "message is required" });
    }

    const response = await handleAssistantMessage({
      patientId: String(patientId),
      message,
      conversationId,
      language,
      actionPayload,
    });
    return res.status(200).json(response);
  } catch (error) {
    const appError = error as HttpError;
    const statusCode = Number(appError?.statusCode) || 500;
    console.error("Patient chatbot error:", error);
    return res.status(statusCode).json({
      message: appError?.message || "Failed to process chatbot message",
    });
  }
};
