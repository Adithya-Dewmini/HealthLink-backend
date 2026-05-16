import type { AssistantResponse, MedicalRiskLevel } from "./assistant.types";

const EMERGENCY_KEYWORDS = [
  "chest pain",
  "breathing difficulty",
  "shortness of breath",
  "severe bleeding",
  "unconscious",
  "fainting",
  "stroke",
  "seizure",
  "severe allergic reaction",
  "pregnancy emergency",
  "severe burns",
  "accident",
  "severe head injury",
  "poisoning",
  "suicidal",
  "self harm",
  "overdose",
] as const;

const MODERATE_RISK_KEYWORDS = [
  "fever",
  "persistent",
  "infection",
  "rash",
  "vomiting",
  "diarrhea",
  "pain",
  "weakness",
  "dizzy",
] as const;

const containsAny = (message: string, keywords: readonly string[]) =>
  keywords.some((keyword) => message.includes(keyword));

export const normalizeMessage = (message: string) => String(message || "").trim().toLowerCase();

export const detectEmergency = (message: string) => containsAny(message, EMERGENCY_KEYWORDS);

export const classifyMedicalRisk = (message: string): MedicalRiskLevel => {
  if (!message.trim()) return "NONE";
  if (detectEmergency(message)) return "URGENT";
  if (containsAny(message, MODERATE_RISK_KEYWORDS)) return "MODERATE";
  return "LOW";
};

export const addHealthDisclaimer = (reply: string) =>
  reply.includes("general guidance only")
    ? reply
    : `${reply} This is general guidance only. Please see a doctor for proper medical advice.`;

export const sanitizeMedicalReply = (reply: string) =>
  addHealthDisclaimer(
    reply
      .replace(/\byou have\b/gi, "this may be")
      .replace(/\btake \d+ ?mg\b/gi, "please consult a doctor about treatment")
      .trim()
  );

export const buildEmergencyResponse = (conversationId: string): AssistantResponse => ({
  conversationId,
  reply:
    "This may need urgent medical attention. Please seek emergency care immediately or contact local emergency support. MediMate cannot handle emergencies.",
  intent: "GENERAL_HEALTH_INFO",
  riskLevel: "URGENT",
  extracted: {},
  actions: [
    { type: "CALL_EMERGENCY", label: "Call emergency support" },
    { type: "OPEN_DOCTOR_SEARCH", label: "Find nearby doctor" },
    { type: "OPEN_MEDICAL_RECORDS", label: "View my medical records" },
  ],
  suggestions: ["Call emergency support", "Find nearby doctor", "View my medical records"],
});

export const sanitizeHealthReply = sanitizeMedicalReply;
