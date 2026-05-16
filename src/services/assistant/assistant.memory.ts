import { randomUUID } from "crypto";
import type { ConversationState } from "./assistant.types";

const MEMORY_TTL_MS = 30 * 60 * 1000;
const conversationStore = new Map<string, ConversationState>();

const buildKey = (patientId: string, conversationId: string) => `${patientId}:${conversationId}`;

export const cleanupExpiredConversations = () => {
  const now = Date.now();
  for (const [key, state] of conversationStore.entries()) {
    if (now - state.updatedAt.getTime() > MEMORY_TTL_MS) {
      conversationStore.delete(key);
    }
  }
};

export const getConversationState = (patientId: string, conversationId?: string) => {
  cleanupExpiredConversations();
  const resolvedConversationId = conversationId?.trim() || randomUUID();
  const key = buildKey(patientId, resolvedConversationId);
  const existing = conversationStore.get(key);

  if (existing) {
    return {
      conversationId: resolvedConversationId,
      state: existing,
    };
  }

  const state: ConversationState = {
    conversationId: resolvedConversationId,
    patientId,
    updatedAt: new Date(),
  };
  conversationStore.set(key, state);
  return { conversationId: resolvedConversationId, state };
};

export const updateConversationState = (
  patientId: string,
  conversationId: string,
  patch: Partial<Omit<ConversationState, "conversationId" | "patientId">>
) => {
  cleanupExpiredConversations();
  const key = buildKey(patientId, conversationId);
  const current =
    conversationStore.get(key) ||
    ({
      conversationId,
      patientId,
      updatedAt: new Date(),
    } satisfies ConversationState);

  const nextState: ConversationState = {
    ...current,
    ...patch,
    updatedAt: new Date(),
  };
  conversationStore.set(key, nextState);
  return nextState;
};

export const clearConversationState = (patientId: string, conversationId: string) => {
  cleanupExpiredConversations();
  conversationStore.delete(buildKey(patientId, conversationId));
};
