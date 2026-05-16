import type { AssistantIntent } from "./assistant.types";

const BOOK_KEYWORDS = ["book", "appointment", "channel", "doctor", "session", "available"] as const;
const SEARCH_KEYWORDS = ["search", "find doctor", "show doctors", "show available doctors", "available doctors"] as const;
const QUEUE_KEYWORDS = ["queue", "turn", "token", "waiting number", "waiting"] as const;
const APPOINTMENT_KEYWORDS = ["my appointment", "next appointment", "upcoming appointment"] as const;
const PRESCRIPTION_KEYWORDS = ["prescription", "medicine", "qr", "rx"] as const;
const RECORD_KEYWORDS = ["history", "reports", "records", "medical record"] as const;
const PHARMACY_KEYWORDS = [
  "pharmacy",
  "medicine",
  "medication",
  "tablets",
  "syrup",
  "capsule",
  "drops",
  "cream",
  "ointment",
  "stock",
  "available",
  "buy medicine",
  "find medicine",
  "search medicine",
  "need medicine",
] as const;
const MEDICINE_AVAILABILITY_KEYWORDS = [
  "do you have",
  "available",
  "in stock",
  "stock",
  "where can i get",
  "nearby pharmacy",
  "pharmacy has",
] as const;
const PRESCRIPTION_FULFILLMENT_KEYWORDS = [
  "prescription order",
  "prescription medicine",
  "scan prescription",
  "qr prescription",
  "upload prescription",
  "fulfill prescription",
  "get my prescription",
] as const;
const ORDER_STATUS_KEYWORDS = [
  "order status",
  "medicine order",
  "pharmacy order",
  "delivery",
  "pickup",
  "my order",
  "track order",
] as const;
const HEALTH_PRODUCT_GUIDANCE_KEYWORDS = [
  "fever care",
  "cough care",
  "cold care",
  "wound care",
  "first aid",
  "vitamins",
  "supplements",
  "baby care",
  "diabetic care",
  "blood pressure monitor",
  "thermometer",
  "masks",
  "sanitizer",
  "what can i get for",
] as const;
const HELP_KEYWORDS = ["help", "how to use", "where can i", "how"] as const;
const SMALL_TALK_KEYWORDS = ["hi", "hello", "thanks", "thank you", "hey"] as const;
const POSITIVE_CONFIRMATION = ["yes", "yes book it", "book it", "go ahead", "confirm"] as const;
const NEGATIVE_RESPONSES = ["no", "not now", "cancel", "don't"] as const;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const DOCTOR_CONTEXT_KEYWORDS = [
  "doctor",
  "doctors",
  "cardiologist",
  "dentist",
  "pediatrician",
  "physician",
  "clinic",
  "clinics",
  "appointment",
  "session",
  "available doctors",
] as const;

const containsAny = (message: string, keywords: readonly string[]) => keywords.some((keyword) => message.includes(keyword));
const startsWithAny = (message: string, keywords: readonly string[]) =>
  keywords.some((keyword) => message === keyword || message.startsWith(`${keyword} `));
const hasDoctorContext = (message: string) => containsAny(message, DOCTOR_CONTEXT_KEYWORDS);

const toDateKey = (date: Date) => date.toISOString().slice(0, 10);

export const isPositiveConfirmation = (message: string) => containsAny(message, POSITIVE_CONFIRMATION);
export const isNegativeResponse = (message: string) => containsAny(message, NEGATIVE_RESPONSES);

export const extractDatePreference = (message: string): string | undefined => {
  const normalized = message.toLowerCase();
  if (normalized.includes("today")) {
    return toDateKey(new Date());
  }
  if (normalized.includes("tomorrow")) {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return toDateKey(date);
  }
  if (normalized.includes("next week")) {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return toDateKey(date);
  }
  const isoMatch = normalized.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (isoMatch?.[0]) {
    return isoMatch[0];
  }
  const weekdayIndex = WEEKDAYS.findIndex((day) => normalized.includes(day));
  if (weekdayIndex >= 0) {
    const now = new Date();
    const target = new Date(now);
    const currentWeekday = now.getDay();
    const desiredWeekday = weekdayIndex === 6 ? 0 : weekdayIndex + 1;
    let delta = desiredWeekday - currentWeekday;
    if (delta <= 0) {
      delta += 7;
    }
    target.setDate(now.getDate() + delta);
    return toDateKey(target);
  }
  return undefined;
};

export const extractTimePreference = (message: string): string | undefined => {
  const normalized = message.toLowerCase();
  if (normalized.includes("morning")) return "morning";
  if (normalized.includes("afternoon")) return "afternoon";
  if (normalized.includes("evening")) return "evening";
  if (normalized.includes("night")) return "night";
  const clockMatch = normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  return clockMatch?.[0]?.trim() || undefined;
};

export const detectIntent = (
  message: string,
  actionPayload?: Record<string, unknown>
): AssistantIntent => {
  const normalized = message.toLowerCase();
  const actionType = typeof actionPayload?.type === "string" ? actionPayload.type : "";
  if (actionType === "SELECT_SESSION") return "SELECT_SESSION";
  if (actionType === "CONFIRM_BOOKING") return "CONFIRM_BOOKING";
  if (actionType === "ADD_TO_CART" || actionType === "CONFIRM_ADD_TO_CART") return "ADD_TO_CART_DRAFT";
  if (containsAny(normalized, SEARCH_KEYWORDS)) return "SEARCH_DOCTORS";
  if (hasDoctorContext(normalized) && containsAny(normalized, BOOK_KEYWORDS)) return "BOOK_APPOINTMENT";
  if (containsAny(normalized, ORDER_STATUS_KEYWORDS)) return "PHARMACY_ORDER_STATUS";
  if (containsAny(normalized, PRESCRIPTION_FULFILLMENT_KEYWORDS)) return "PRESCRIPTION_FULFILLMENT";
  if (containsAny(normalized, HEALTH_PRODUCT_GUIDANCE_KEYWORDS)) return "HEALTH_PRODUCT_GUIDANCE";
  if (containsAny(normalized, MEDICINE_AVAILABILITY_KEYWORDS)) return "MEDICINE_AVAILABILITY";
  if (containsAny(normalized, PHARMACY_KEYWORDS)) return "PHARMACY_SEARCH";
  if (containsAny(normalized, APPOINTMENT_KEYWORDS)) return "VIEW_APPOINTMENTS";
  if (containsAny(normalized, QUEUE_KEYWORDS)) return "VIEW_QUEUE";
  if (containsAny(normalized, PRESCRIPTION_KEYWORDS)) return "VIEW_PRESCRIPTION";
  if (containsAny(normalized, RECORD_KEYWORDS)) return "VIEW_MEDICAL_RECORDS";
  if (containsAny(normalized, HELP_KEYWORDS)) return "APP_HELP";
  if (startsWithAny(normalized, SMALL_TALK_KEYWORDS)) return "SMALL_TALK";
  if (isPositiveConfirmation(normalized)) return "CONFIRM_BOOKING";
  if (containsAny(normalized, BOOK_KEYWORDS)) return "BOOK_APPOINTMENT";
  return "UNKNOWN";
};
