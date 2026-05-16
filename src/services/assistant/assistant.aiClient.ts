import { env } from "../../config/env";
import type { AssistantAiParseResult, ConversationState, AssistantRequestContext } from "./assistant.types";

const VALID_INTENTS = new Set([
  "BOOK_APPOINTMENT",
  "SEARCH_DOCTORS",
  "SELECT_SESSION",
  "CONFIRM_BOOKING",
  "VIEW_QUEUE",
  "VIEW_APPOINTMENTS",
  "VIEW_PRESCRIPTION",
  "VIEW_MEDICAL_RECORDS",
  "GENERAL_HEALTH_INFO",
  "APP_HELP",
  "SMALL_TALK",
  "UNKNOWN",
]);
const VALID_RISK = new Set(["NONE", "LOW", "MODERATE", "URGENT"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isAIEnabled = () => Boolean(env.aiAssistantEnabled && env.openaiApiKey);

export const parseMessageWithAI = async (
  context: AssistantRequestContext,
  conversationState: ConversationState
): Promise<AssistantAiParseResult | null> => {
  if (!isAIEnabled()) {
    return null;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.openaiModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are MediMate, the HealthLink patient assistant. You are not a doctor. Extract intent and entities only. Do not diagnose. Do not prescribe. Do not invent app data. Do not confirm appointments. Mark emergencies as URGENT.",
          },
          {
            role: "user",
            content: JSON.stringify({
              patientId: context.patientId,
              message: context.message,
              language: context.language || "en",
              actionPayload: context.actionPayload ?? null,
              conversationState: conversationState.pendingBooking ?? null,
            }),
          },
        ],
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) return null;
    const parsed = JSON.parse(content) as unknown;
    if (!isObject(parsed)) return null;
    const intent = typeof parsed.intent === "string" && VALID_INTENTS.has(parsed.intent) ? parsed.intent : undefined;
    const riskLevel =
      typeof parsed.riskLevel === "string" && VALID_RISK.has(parsed.riskLevel) ? parsed.riskLevel : undefined;
    const extracted = isObject(parsed.extracted) ? parsed.extracted : undefined;
    return {
      intent: intent as AssistantAiParseResult["intent"],
      riskLevel: riskLevel as AssistantAiParseResult["riskLevel"],
      extracted: extracted as AssistantAiParseResult["extracted"],
      needsFollowUp: typeof parsed.needsFollowUp === "boolean" ? parsed.needsFollowUp : undefined,
      followUpQuestion:
        typeof parsed.followUpQuestion === "string" && parsed.followUpQuestion.trim()
          ? parsed.followUpQuestion.trim()
          : undefined,
    };
  } catch {
    return null;
  }
};
