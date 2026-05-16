export type AssistantIntent =
  | "BOOK_APPOINTMENT"
  | "SEARCH_DOCTORS"
  | "SELECT_SESSION"
  | "CONFIRM_BOOKING"
  | "VIEW_QUEUE"
  | "VIEW_APPOINTMENTS"
  | "VIEW_PRESCRIPTION"
  | "VIEW_MEDICAL_RECORDS"
  | "PHARMACY_SEARCH"
  | "MEDICINE_AVAILABILITY"
  | "PRESCRIPTION_FULFILLMENT"
  | "PHARMACY_ORDER_STATUS"
  | "ADD_TO_CART_DRAFT"
  | "HEALTH_PRODUCT_GUIDANCE"
  | "GENERAL_HEALTH_INFO"
  | "APP_HELP"
  | "SMALL_TALK"
  | "UNKNOWN";

export type MedicalRiskLevel = "NONE" | "LOW" | "MODERATE" | "URGENT";

export type AssistantActionType =
  | "OPEN_DOCTOR_SEARCH"
  | "SHOW_SESSION_RESULTS"
  | "SELECT_SESSION"
  | "CONFIRM_BOOKING"
  | "OPEN_QUEUE"
  | "OPEN_APPOINTMENTS"
  | "OPEN_PRESCRIPTIONS"
  | "OPEN_MEDICAL_RECORDS"
  | "SHOW_MEDICINE_RESULTS"
  | "SHOW_PHARMACY_RESULTS"
  | "OPEN_PHARMACY_SEARCH"
  | "OPEN_PHARMACY_PRODUCT"
  | "ADD_TO_CART"
  | "CONFIRM_ADD_TO_CART"
  | "OPEN_CART"
  | "OPEN_ORDER_STATUS"
  | "OPEN_PRESCRIPTION_ORDER"
  | "BOOK_DOCTOR_FOR_MEDICINE"
  | "CALL_EMERGENCY"
  | "ASK_FOLLOW_UP"
  | "CLEAR_CONTEXT";

export type AssistantExtractedEntities = {
  symptoms?: string[];
  specialty?: string;
  preferredDate?: string;
  preferredTime?: string;
  doctorName?: string;
  medicalCenterName?: string;
  medicineName?: string;
  medicineCategory?: string;
  pharmacyName?: string;
  orderId?: string;
  prescriptionId?: string;
  dosageForm?: string;
  appointmentId?: string;
  sessionId?: string;
};

export type AssistantAction = {
  type: AssistantActionType;
  label: string;
  payload?: Record<string, unknown>;
  requiresConfirmation?: boolean;
};

export type MedicineRecommendation = {
  productId: string;
  medicineName: string;
  genericName?: string;
  brandName?: string;
  category?: string;
  dosageForm?: string;
  strength?: string;
  pharmacyName?: string;
  pharmacyId?: string;
  price?: number;
  currency?: string;
  stockStatus: "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK" | "UNKNOWN";
  requiresPrescription?: boolean;
  imageUrl?: string;
  safetyNote?: string;
  matchReason?: string;
  matchConfidence?: number;
};

export type PharmacyRecommendation = {
  pharmacyId: string;
  pharmacyName: string;
  address?: string;
  distanceKm?: number;
  openStatus?: "OPEN" | "CLOSED" | "UNKNOWN";
  availableItems?: number;
};

export type AssistantResponse = {
  reply: string;
  intent: AssistantIntent;
  riskLevel: MedicalRiskLevel;
  extracted: AssistantExtractedEntities;
  actions: AssistantAction[];
  suggestions: string[];
  conversationId: string;
  medicineResults?: MedicineRecommendation[];
  pharmacyResults?: PharmacyRecommendation[];
};

export type AssistantRequestContext = {
  patientId: string;
  message: string;
  conversationId?: string;
  language?: "en" | "si" | "ta";
  actionPayload?: Record<string, unknown>;
};

export type ConversationState = {
  conversationId: string;
  patientId: string;
  lastIntent?: AssistantIntent;
  extracted?: AssistantExtractedEntities;
  pendingBooking?: {
    specialty?: string;
    symptoms?: string[];
    preferredDate?: string;
    preferredTime?: string;
    selectedSessionId?: string;
    selectedDoctorName?: string;
    selectedMedicalCenterName?: string;
  };
  updatedAt: Date;
};

export type AssistantSessionCard = {
  sessionId: string;
  doctorName: string;
  specialty: string;
  medicalCenterName: string;
  date: string;
  time: string;
  availableSlots?: number;
  doctorId?: string;
  medicalCenterId?: string;
};

export type AssistantAiParseResult = {
  intent?: AssistantIntent;
  riskLevel?: MedicalRiskLevel;
  extracted?: AssistantExtractedEntities;
  needsFollowUp?: boolean;
  followUpQuestion?: string;
};
