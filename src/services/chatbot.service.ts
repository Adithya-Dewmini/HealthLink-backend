import { handleAssistantMessage } from "./assistant/assistant.orchestrator";
import { detectIntent } from "./assistant/assistant.intent";
import { inferSpecialty } from "./assistant/assistant.specialty";
import type {
  AssistantAction as ChatbotAction,
  AssistantActionType as ChatbotActionType,
  AssistantIntent as ChatbotIntent,
  AssistantResponse as ChatbotResponse,
  AssistantRequestContext,
} from "./assistant/assistant.types";

export type { ChatbotAction, ChatbotActionType, ChatbotIntent, ChatbotResponse };

export const detectSpecialtyFromMessage = (message: string): string | null =>
  inferSpecialty(String(message || "").trim().toLowerCase()).specialty ?? null;

export const detectChatbotIntent = (message: string): ChatbotIntent => {
  const normalized = String(message || "").trim().toLowerCase();
  return detectIntent(normalized);
};

export const getChatbotRecoverySuggestions = () => ["Try again", "Book Doctor", "My Queue"];

export const buildPatientChatbotResponse = async (
  message: string,
  options?: Partial<AssistantRequestContext>
) =>
  handleAssistantMessage({
    patientId: options?.patientId || "0",
    message,
    conversationId: options?.conversationId,
    language: options?.language,
    actionPayload: options?.actionPayload,
  });
