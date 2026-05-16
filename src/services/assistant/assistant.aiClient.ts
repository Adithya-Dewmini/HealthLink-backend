import { env } from "../../config/env";
import { sanitizeAIHealthReply } from "./assistant.guardrails";
import type {
  AIChatResult,
  AssistantAction,
  AssistantActionType,
  AssistantExtractedEntities,
  AssistantIntent,
  MedicalRiskLevel,
} from "./assistant.types";

const VALID_INTENTS = new Set<AssistantIntent>([
  "GENERAL_HEALTH_INFO",
  "APP_HELP",
  "PHARMACY_SEARCH",
  "MEDICINE_AVAILABILITY",
  "PRESCRIPTION_FULFILLMENT",
  "PHARMACY_ORDER_STATUS",
  "BOOK_APPOINTMENT",
  "VIEW_QUEUE",
  "VIEW_PRESCRIPTION",
  "VIEW_MEDICAL_RECORDS",
  "UNKNOWN",
]);

const VALID_RISK = new Set<MedicalRiskLevel>(["NONE", "LOW", "MODERATE", "URGENT"]);

const SAFE_ACTION_TYPES = new Set<AssistantActionType>([
  "OPEN_DOCTOR_SEARCH",
  "OPEN_PRESCRIPTIONS",
  "OPEN_PHARMACY_SEARCH",
  "OPEN_QUEUE",
  "OPEN_MEDICAL_RECORDS",
  "OPEN_ORDER_STATUS",
  "OPEN_CART",
  "OPEN_APPOINTMENTS",
  "OPEN_PRESCRIPTION_ORDER",
  "ASK_FOLLOW_UP",
  "CLEAR_CONTEXT",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toOptionalString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeExtracted = (value: unknown): AssistantExtractedEntities | undefined => {
  if (!isObject(value)) return undefined;

  const symptoms = Array.isArray(value.symptoms)
    ? value.symptoms
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : undefined;

  return {
    medicineName: toOptionalString(value.medicineName),
    medicineCategory: toOptionalString(value.medicineCategory),
    specialty: toOptionalString(value.specialty),
    symptoms: symptoms?.length ? symptoms : undefined,
  };
};

const normalizeSuggestedActions = (value: unknown): AssistantAction[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const actions: AssistantAction[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const type = toOptionalString(entry.type) as AssistantActionType | undefined;
    const label = toOptionalString(entry.label);
    if (!type || !label || !SAFE_ACTION_TYPES.has(type)) {
      continue;
    }
    actions.push({
      type,
      label,
      payload: isObject(entry.payload) ? entry.payload : undefined,
    });
  }

  return actions.length ? actions : undefined;
};

const isAIEnabled = () =>
  String(process.env.AI_ASSISTANT_ENABLED ?? (env.aiAssistantEnabled ? "true" : "false")).trim().toLowerCase() === "true" &&
  Boolean((process.env.OPENAI_API_KEY || env.openaiApiKey || "").trim());

const getModel = () => (process.env.OPENAI_MODEL || env.openaiModel || "gpt-4o-mini").trim() || "gpt-4o-mini";

export const generateSmartAssistantReply = async (params: {
  message: string;
  conversationSummary?: string;
  healthlinkKnowledge: string;
  currentIntent?: AssistantIntent;
  extracted?: AssistantExtractedEntities;
  medicineSafety?: {
    level: string;
    requiresPrescription: boolean;
    warning?: string;
  };
}): Promise<AIChatResult | null> => {
  if (!isAIEnabled()) {
    return null;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(process.env.OPENAI_API_KEY || env.openaiApiKey || "").trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getModel(),
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are MediMate, the patient assistant inside HealthLink.\n" +
              "You help patients use the HealthLink app and provide simple general health and pharmacy guidance.\n" +
              "You are not a doctor.\n" +
              "You must not diagnose diseases.\n" +
              "You must not prescribe medicines.\n" +
              "You must not give dosage instructions.\n" +
              "You must not say a patient should take a specific medicine.\n" +
              "You may explain what a medicine is generally used for.\n" +
              "You must advise consulting a doctor/pharmacist for symptoms, medicine uncertainty, prescription medicines, children, pregnancy, chronic disease, or symptoms that continue.\n" +
              "You must use HealthLink app context when relevant.\n" +
              "You can suggest app actions such as booking a doctor, opening prescriptions, searching pharmacy, checking queue, or viewing orders.\n" +
              "You must never invent real doctor/session/product/order data.\n" +
              "You must return JSON only.\n" +
              "Expected JSON:\n" +
              "{\n" +
              '  "reply": "string",\n' +
              '  "intent": "GENERAL_HEALTH_INFO | APP_HELP | PHARMACY_SEARCH | MEDICINE_AVAILABILITY | PRESCRIPTION_FULFILLMENT | PHARMACY_ORDER_STATUS | BOOK_APPOINTMENT | VIEW_QUEUE | VIEW_PRESCRIPTION | VIEW_MEDICAL_RECORDS | UNKNOWN",\n' +
              '  "riskLevel": "NONE | LOW | MODERATE | URGENT",\n' +
              '  "extracted": { "medicineName": "string optional", "medicineCategory": "string optional", "symptoms": ["string"], "specialty": "string optional" },\n' +
              '  "suggestedActions": [{ "type": "OPEN_DOCTOR_SEARCH | OPEN_PRESCRIPTIONS | OPEN_PHARMACY_SEARCH | OPEN_QUEUE | OPEN_MEDICAL_RECORDS | OPEN_ORDER_STATUS", "label": "string", "payload": {} }],\n' +
              '  "shouldSearchMedicine": false,\n' +
              '  "medicineSearchQuery": "string optional",\n' +
              '  "shouldBookDoctor": false,\n' +
              '  "doctorSearchSpecialty": "string optional"\n' +
              "}",
          },
          {
            role: "user",
            content: JSON.stringify({
              message: params.message,
              conversationSummary: params.conversationSummary ?? "",
              currentIntent: params.currentIntent ?? null,
              extracted: params.extracted ?? {},
              medicineSafety: params.medicineSafety ?? null,
              healthlinkKnowledge: params.healthlinkKnowledge,
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

    const reply = toOptionalString(parsed.reply);
    if (!reply) return null;

    const intent = toOptionalString(parsed.intent) as AssistantIntent | undefined;
    const riskLevel = toOptionalString(parsed.riskLevel) as MedicalRiskLevel | undefined;
    const suggestedActions = normalizeSuggestedActions(parsed.suggestedActions);

    return {
      reply: sanitizeAIHealthReply(reply),
      intent: intent && VALID_INTENTS.has(intent) ? intent : undefined,
      riskLevel: riskLevel && VALID_RISK.has(riskLevel) ? riskLevel : undefined,
      extracted: normalizeExtracted(parsed.extracted),
      suggestedActions,
      shouldSearchMedicine: parsed.shouldSearchMedicine === true,
      medicineSearchQuery: toOptionalString(parsed.medicineSearchQuery),
      shouldBookDoctor: parsed.shouldBookDoctor === true,
      doctorSearchSpecialty: toOptionalString(parsed.doctorSearchSpecialty),
    };
  } catch {
    return null;
  }
};
