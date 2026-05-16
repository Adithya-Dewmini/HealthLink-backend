import {
  addHealthDisclaimer,
  buildEmergencyResponse,
  classifyMedicalRisk,
  detectEmergency,
  normalizeMessage,
  sanitizeMedicalReply,
} from "./assistant.guardrails";
import { parseMessageWithAI } from "./assistant.aiClient";
import {
  detectIntent,
  extractDatePreference,
  extractTimePreference,
  isNegativeResponse,
  isPositiveConfirmation,
} from "./assistant.intent";
import { clearConversationState, getConversationState, updateConversationState } from "./assistant.memory";
import { classifyMedicineSafety } from "./assistant.medicineSafety";
import {
  extractDosageForm,
  extractMedicineName,
  inferPharmacyCategory,
  normalizeMedicineQuery,
} from "./assistant.pharmacy";
import { inferSpecialty } from "./assistant.specialty";
import {
  confirmAddToCart,
  confirmAppointmentBooking,
  createCartDraft,
  createAppointmentDraft,
  getPatientActivePrescriptions,
  getPatientMedicalHistorySummary,
  getPatientPharmacyOrders,
  getPatientQueueStatus,
  getPatientPrescriptionOrderOptions,
  getPatientUpcomingAppointments,
  searchPharmaciesWithProduct,
  searchPharmacyProducts,
  searchDoctorSessions,
} from "./assistant.tools";
import type {
  AssistantAction,
  AssistantExtractedEntities,
  AssistantRequestContext,
  AssistantResponse,
  ConversationState,
} from "./assistant.types";

const buildDoctorSearchAction = (extracted: AssistantExtractedEntities): AssistantAction => ({
  type: "OPEN_DOCTOR_SEARCH",
  label: extracted.specialty ? `Find ${extracted.specialty}` : "Find doctor",
  payload: {
    ...(extracted.specialty ? { initialQuery: extracted.specialty, specialty: extracted.specialty } : {}),
    ...(extracted.symptoms?.[0] ? { reason: extracted.symptoms[0] } : {}),
    ...(extracted.preferredDate ? { preferredDate: extracted.preferredDate } : {}),
    ...(extracted.preferredTime ? { preferredTime: extracted.preferredTime } : {}),
  },
});

const mergeExtracted = (
  base: AssistantExtractedEntities,
  next?: AssistantExtractedEntities
): AssistantExtractedEntities => ({
  symptoms: next?.symptoms?.length ? next.symptoms : base.symptoms,
  specialty: next?.specialty || base.specialty,
  preferredDate: next?.preferredDate || base.preferredDate,
  preferredTime: next?.preferredTime || base.preferredTime,
  doctorName: next?.doctorName || base.doctorName,
  medicalCenterName: next?.medicalCenterName || base.medicalCenterName,
  medicineName: next?.medicineName || base.medicineName,
  medicineCategory: next?.medicineCategory || base.medicineCategory,
  pharmacyName: next?.pharmacyName || base.pharmacyName,
  orderId: next?.orderId || base.orderId,
  prescriptionId: next?.prescriptionId || base.prescriptionId,
  dosageForm: next?.dosageForm || base.dosageForm,
  appointmentId: next?.appointmentId || base.appointmentId,
  sessionId: next?.sessionId || base.sessionId,
});

const buildHealthReply = (normalized: string, specialty?: string) => {
  if (normalized.includes("fever")) {
    return sanitizeMedicalReply(
      `Fever can have many causes. ${specialty || "A doctor"} may be a good starting point. I can help you find available doctors.`
    );
  }
  if (normalized.includes("tooth") || normalized.includes("dental") || normalized.includes("gum")) {
    return sanitizeMedicalReply(
      `Tooth pain can have different causes. A Dentist may be a good starting point. I can help you find available doctors.`
    );
  }
  return addHealthDisclaimer(
    `I can share simple health guidance only. If symptoms continue, worsen, or worry you, please book a doctor through HealthLink.`
  );
};

const buildBaseExtracted = (normalized: string) => {
  const inferred = inferSpecialty(normalized);
  const categoryHint = inferPharmacyCategory(normalized);
  return {
    symptoms: inferred.symptoms,
    specialty: inferred.specialty,
    preferredDate: extractDatePreference(normalized),
    preferredTime: extractTimePreference(normalized),
    medicineName: extractMedicineName(normalized),
    medicineCategory: categoryHint?.category,
    dosageForm: extractDosageForm(normalized),
  } satisfies AssistantExtractedEntities;
};

const buildSmallTalkResponse = (conversationId: string): AssistantResponse => ({
  conversationId,
  reply:
    "Hi, I’m MediMate. I can help you book doctors, check your queue, view prescriptions, or answer simple health questions.",
  intent: "SMALL_TALK",
  riskLevel: "NONE",
  extracted: {},
  actions: [],
  suggestions: ["Book a doctor", "What is my queue number?", "Show my prescriptions"],
});

const buildUnknownResponse = (conversationId: string): AssistantResponse => ({
  conversationId,
  reply:
    "I can help with doctor booking, queue status, prescriptions, pharmacy items, order help, medical records, and simple health questions.",
  intent: "UNKNOWN",
  riskLevel: "NONE",
  extracted: {},
  actions: [],
  suggestions: ["Book a doctor", "Search pharmacy", "Show my prescriptions"],
});

const buildPharmacySearchAction = (extracted: AssistantExtractedEntities): AssistantAction => ({
  type: "OPEN_PHARMACY_SEARCH",
  label: extracted.medicineName || extracted.medicineCategory ? "Search Pharmacy" : "Open Pharmacy",
  payload: {
    ...((extracted.medicineName || extracted.medicineCategory)
      ? {
          initialQuery: extracted.medicineName || extracted.medicineCategory,
          ...(extracted.medicineName ? { medicineName: extracted.medicineName } : {}),
        }
      : {}),
    ...(extracted.medicineCategory ? { category: extracted.medicineCategory } : {}),
    ...(extracted.symptoms?.[0] ? { reason: extracted.symptoms[0] } : {}),
  },
});

const buildMedicineDoctorAction = (specialty?: string): AssistantAction => ({
  type: "BOOK_DOCTOR_FOR_MEDICINE",
  label: specialty ? `Book ${specialty}` : "Book a Doctor",
  payload: {
    initialQuery: specialty || "General Physician",
    specialty: specialty || "General Physician",
  },
});

const BOOKING_FLOW_INTENTS = new Set<AssistantResponse["intent"]>([
  "BOOK_APPOINTMENT",
  "SEARCH_DOCTORS",
  "SELECT_SESSION",
  "CONFIRM_BOOKING",
]);

const buildStateExtracted = (state: ConversationState): AssistantExtractedEntities => ({
  symptoms: state.pendingBooking?.symptoms?.length ? state.pendingBooking.symptoms : state.extracted?.symptoms,
  specialty: state.pendingBooking?.specialty || state.extracted?.specialty,
  preferredDate: state.pendingBooking?.preferredDate || state.extracted?.preferredDate,
  preferredTime: state.pendingBooking?.preferredTime || state.extracted?.preferredTime,
  doctorName: state.pendingBooking?.selectedDoctorName || state.extracted?.doctorName,
  medicalCenterName: state.pendingBooking?.selectedMedicalCenterName || state.extracted?.medicalCenterName,
  sessionId: state.pendingBooking?.selectedSessionId || state.extracted?.sessionId,
  medicineName: state.extracted?.medicineName,
  medicineCategory: state.extracted?.medicineCategory,
  pharmacyName: state.extracted?.pharmacyName,
  orderId: state.extracted?.orderId,
  prescriptionId: state.extracted?.prescriptionId,
  dosageForm: state.extracted?.dosageForm,
  appointmentId: state.extracted?.appointmentId,
});

const hasBookingFollowUpSignals = (
  extracted: AssistantExtractedEntities,
  aiIntent?: AssistantResponse["intent"]
) =>
  Boolean(
    extracted.specialty ||
      extracted.preferredDate ||
      extracted.preferredTime ||
      extracted.doctorName ||
      extracted.medicalCenterName ||
      extracted.symptoms?.length ||
      aiIntent === "BOOK_APPOINTMENT" ||
      aiIntent === "SEARCH_DOCTORS"
  );

const shouldContinueBookingFlow = (state: ConversationState) =>
  Boolean(state.pendingBooking) || BOOKING_FLOW_INTENTS.has(state.lastIntent ?? "UNKNOWN");

const resolveIntent = (
  detectedIntent: AssistantResponse["intent"],
  state: ConversationState,
  extracted: AssistantExtractedEntities,
  aiIntent?: AssistantResponse["intent"]
): AssistantResponse["intent"] => {
  if (detectedIntent === "UNKNOWN" && aiIntent) {
    return aiIntent;
  }

  if (
    (detectedIntent === "UNKNOWN" || detectedIntent === "GENERAL_HEALTH_INFO") &&
    shouldContinueBookingFlow(state) &&
    hasBookingFollowUpSignals(extracted, aiIntent)
  ) {
    return "BOOK_APPOINTMENT";
  }

  return detectedIntent;
};

const buildQueueReply = (queue: Awaited<ReturnType<typeof getPatientQueueStatus>>) => {
  if (!queue) {
    return "You can check your current queue progress, token number, and waiting details from the queue screen.";
  }

  if (queue.patientStatus === "WITH_DOCTOR") {
    return `You are currently with ${queue.doctorName} at ${queue.medicalCenterName}. Your token is ${queue.tokenNumber ?? "-"}.`;
  }

  const waitingContext =
    typeof queue.waitingCount === "number" && queue.waitingCount > 0
      ? ` There ${queue.waitingCount === 1 ? "is" : "are"} ${queue.waitingCount} waiting patient${
          queue.waitingCount === 1 ? "" : "s"
        } in this queue.`
      : "";
  const currentContext = queue.currentToken ? ` The current token is ${queue.currentToken}.` : "";

  return `You are queued for ${queue.doctorName} at ${queue.medicalCenterName}. Your token is ${
    queue.tokenNumber ?? "-"
  }.${currentContext}${waitingContext}`;
};

const handleSelectSession = (
  context: AssistantRequestContext,
  conversationId: string,
  state: ConversationState
): AssistantResponse => {
  const sessionId =
    typeof context.actionPayload?.sessionId === "string" || typeof context.actionPayload?.sessionId === "number"
      ? String(context.actionPayload.sessionId)
      : "";
  const session =
    context.actionPayload?.session && typeof context.actionPayload.session === "object"
      ? (context.actionPayload.session as Record<string, unknown>)
      : undefined;

  if (!sessionId) {
    return {
      conversationId,
      reply: "Please choose a session first.",
      intent: "SELECT_SESSION",
      riskLevel: "NONE",
      extracted: state.extracted ?? {},
      actions: [{ type: "ASK_FOLLOW_UP", label: "Choose a session" }],
      suggestions: ["Show available doctors", "Book a doctor"],
    };
  }

  const pendingBooking = {
    ...state.pendingBooking,
    selectedSessionId: sessionId,
    selectedDoctorName: typeof session?.doctorName === "string" ? session.doctorName : state.pendingBooking?.selectedDoctorName,
    selectedMedicalCenterName:
      typeof session?.medicalCenterName === "string"
        ? session.medicalCenterName
        : state.pendingBooking?.selectedMedicalCenterName,
  };
  const extracted = mergeExtracted(state.extracted ?? {}, {
    sessionId,
    doctorName: pendingBooking.selectedDoctorName,
    medicalCenterName: pendingBooking.selectedMedicalCenterName,
  });

  updateConversationState(context.patientId, conversationId, {
    lastIntent: "SELECT_SESSION",
    extracted,
    pendingBooking,
  });

  return {
    conversationId,
    reply: `You selected${pendingBooking.selectedDoctorName ? ` ${pendingBooking.selectedDoctorName}` : " a session"}. Please confirm before I place the booking.`,
    intent: "SELECT_SESSION",
    riskLevel: "NONE",
    extracted,
    actions: [
      {
        type: "CONFIRM_BOOKING",
        label: "Confirm Booking",
        payload: { type: "CONFIRM_BOOKING", selectedSessionId: sessionId, confirmation: true },
        requiresConfirmation: true,
      },
    ],
    suggestions: ["Confirm booking", "Show available doctors"],
  };
};

const handleConfirmBooking = async (
  context: AssistantRequestContext,
  conversationId: string,
  state: ConversationState
): Promise<AssistantResponse> => {
  const selectedSessionId =
    typeof context.actionPayload?.selectedSessionId === "string" || typeof context.actionPayload?.selectedSessionId === "number"
      ? String(context.actionPayload.selectedSessionId)
      : state.pendingBooking?.selectedSessionId;
  const confirmation = context.actionPayload?.confirmation === true;

  if (!selectedSessionId) {
    return {
      conversationId,
      reply: "Please choose a session first. I cannot book from text alone.",
      intent: "CONFIRM_BOOKING",
      riskLevel: "NONE",
      extracted: state.extracted ?? {},
      actions: [{ type: "ASK_FOLLOW_UP", label: "Choose a session" }],
      suggestions: ["Show available doctors", "Book a doctor"],
    };
  }

  if (!confirmation) {
    return {
      conversationId,
      reply: "Please tap Confirm Booking to finish this appointment.",
      intent: "CONFIRM_BOOKING",
      riskLevel: "NONE",
      extracted: mergeExtracted(state.extracted ?? {}, { sessionId: selectedSessionId }),
      actions: [
        {
          type: "CONFIRM_BOOKING",
          label: "Confirm Booking",
          payload: { type: "CONFIRM_BOOKING", selectedSessionId, confirmation: true },
          requiresConfirmation: true,
        },
      ],
      suggestions: ["Confirm booking", "Show available doctors"],
    };
  }

  let booking;
  try {
    booking = await confirmAppointmentBooking({
      patientId: context.patientId,
      selectedSessionId,
      confirmation,
    });
  } catch (error) {
    const appError = error as Error & { statusCode?: number };
    const statusCode = Number(appError?.statusCode) || 500;

    if (statusCode >= 400 && statusCode < 500) {
      const extracted = mergeExtracted(state.extracted ?? {}, { sessionId: selectedSessionId });
      updateConversationState(context.patientId, conversationId, {
        lastIntent: "BOOK_APPOINTMENT",
        extracted,
        pendingBooking: {
          ...state.pendingBooking,
          selectedSessionId: undefined,
        },
      });

      return {
        conversationId,
        reply:
          statusCode === 403
            ? "That session belongs to a medical center that is not currently approved for patient bookings. Please choose another available doctor or clinic."
            : appError?.message || "That session is no longer available. Please choose another one.",
        intent: "CONFIRM_BOOKING",
        riskLevel: "NONE",
        extracted,
        actions: [
          buildDoctorSearchAction(extracted),
          { type: "ASK_FOLLOW_UP", label: "Choose another session" },
        ],
        suggestions: ["Show available doctors", "Book a doctor", "View my appointments"],
      };
    }

    throw error;
  }

  clearConversationState(context.patientId, conversationId);
  return {
    conversationId,
    reply: `Your appointment has been booked for ${booking.date} at ${booking.time}.`,
    intent: "CONFIRM_BOOKING",
    riskLevel: "NONE",
    extracted: { sessionId: booking.sessionId },
    actions: [{ type: "OPEN_APPOINTMENTS", label: "View My Appointments" }],
    suggestions: ["View my appointments", "Book a doctor", "Show my prescriptions"],
  };
};

export const handleAssistantMessage = async (context: AssistantRequestContext): Promise<AssistantResponse> => {
  const normalized = normalizeMessage(context.message);
  const { conversationId, state } = getConversationState(context.patientId, context.conversationId);

  if (detectEmergency(normalized)) {
    updateConversationState(context.patientId, conversationId, { lastIntent: "GENERAL_HEALTH_INFO" });
    return buildEmergencyResponse(conversationId);
  }

  const detectedIntent = detectIntent(normalized, context.actionPayload);
  const ruleExtracted = buildBaseExtracted(normalized);
  const ai = await parseMessageWithAI(context, state);
  const extracted = mergeExtracted(mergeExtracted(buildStateExtracted(state), ruleExtracted), ai?.extracted);
  const intent = resolveIntent(detectedIntent, state, extracted, ai?.intent);
  const riskLevel =
    ai?.riskLevel || (intent === "GENERAL_HEALTH_INFO" || extracted.symptoms?.length ? classifyMedicalRisk(normalized) : "NONE");

  if (!context.actionPayload && shouldContinueBookingFlow(state) && isNegativeResponse(normalized)) {
    clearConversationState(context.patientId, conversationId);
    return {
      conversationId,
      reply: "Okay, I cancelled the current booking flow. If you want, I can help you start again anytime.",
      intent: "BOOK_APPOINTMENT",
      riskLevel: "NONE",
      extracted: {},
      actions: [buildDoctorSearchAction({})],
      suggestions: ["Book a doctor", "Show available doctors", "View my appointments"],
    };
  }

  if (intent === "SELECT_SESSION") {
    return handleSelectSession(context, conversationId, state);
  }

  if (intent === "CONFIRM_BOOKING" && (context.actionPayload || isPositiveConfirmation(normalized))) {
    return handleConfirmBooking(context, conversationId, state);
  }

  if (intent === "ADD_TO_CART_DRAFT") {
    const actionType = typeof context.actionPayload?.type === "string" ? context.actionPayload.type : "";
    const productId =
      typeof context.actionPayload?.productId === "string" || typeof context.actionPayload?.productId === "number"
        ? String(context.actionPayload.productId)
        : undefined;
    const quantity = Number(context.actionPayload?.quantity ?? 1) || 1;
    const requiresPrescription = context.actionPayload?.requiresPrescription === true;

    if (requiresPrescription) {
      return {
        conversationId,
        reply:
          "This medicine may require a valid prescription or pharmacist/doctor review. I can help you view your prescriptions or book a doctor.",
        intent,
        riskLevel: "MODERATE",
        extracted,
        actions: [
          { type: "OPEN_PRESCRIPTIONS", label: "View Prescriptions" },
          buildMedicineDoctorAction(extracted.specialty),
          buildPharmacySearchAction(extracted),
        ],
        suggestions: ["Show my prescriptions", "Book a doctor", "Search pharmacy"],
      };
    }

    if (actionType === "CONFIRM_ADD_TO_CART") {
      const confirmation = context.actionPayload?.confirmation === true;
      if (!confirmation) {
        return {
          conversationId,
          reply: "Please confirm before I add this pharmacy item to your cart.",
          intent,
          riskLevel: "NONE",
          extracted,
          actions: [
            {
              type: "CONFIRM_ADD_TO_CART",
              label: "Confirm Add to Cart",
              payload: {
                type: "CONFIRM_ADD_TO_CART",
                productId,
                quantity,
                confirmation: true,
              },
              requiresConfirmation: true,
            },
          ],
          suggestions: ["Confirm add to cart", "Search pharmacy", "Show my prescriptions"],
        };
      }

      const result = await confirmAddToCart({
        patientId: context.patientId,
        productId,
        quantity,
        confirmation,
      });

      return {
        conversationId,
        reply: "Added to your cart.",
        intent,
        riskLevel: "NONE",
        extracted,
        actions: [{ type: "OPEN_CART", label: "Open Cart" }],
        suggestions: ["Open cart", "Track my order", "Search pharmacy"],
      };
    }

    if (!productId) {
      return {
        conversationId,
        reply: "Please choose a pharmacy item first.",
        intent,
        riskLevel: "NONE",
        extracted,
        actions: [buildPharmacySearchAction(extracted)],
        suggestions: ["Search pharmacy", "Show my prescriptions", "Book a doctor"],
      };
    }

    await createCartDraft(context.patientId, productId, quantity);
    return {
      conversationId,
      reply: "Add this item to your cart?",
      intent,
      riskLevel: "NONE",
      extracted,
      actions: [
        {
          type: "CONFIRM_ADD_TO_CART",
          label: "Confirm Add to Cart",
          payload: {
            type: "CONFIRM_ADD_TO_CART",
            productId,
            quantity,
            confirmation: true,
          },
          requiresConfirmation: true,
        },
      ],
      suggestions: ["Confirm add to cart", "Search pharmacy", "Show my prescriptions"],
    };
  }

  if (intent === "SMALL_TALK") {
    updateConversationState(context.patientId, conversationId, { lastIntent: "SMALL_TALK", extracted });
    return buildSmallTalkResponse(conversationId);
  }

  if (intent === "APP_HELP") {
    return {
      conversationId,
      reply:
        "I can help you book doctors, check queue status, view appointments, open prescriptions, search pharmacy items, track orders, and review medical records.",
      intent,
      riskLevel: "NONE",
      extracted,
      actions: [],
      suggestions: ["Book a doctor", "Search pharmacy", "Show my prescriptions"],
    };
  }

  if (intent === "VIEW_QUEUE") {
    const queue = await getPatientQueueStatus(context.patientId);
    updateConversationState(context.patientId, conversationId, { lastIntent: intent, extracted });
    return {
      conversationId,
      reply: buildQueueReply(queue),
      intent,
      riskLevel: "NONE",
      extracted,
      actions: [{ type: "OPEN_QUEUE", label: "Open My Queue" }],
      suggestions: ["What is my queue number?", "Book a doctor", "View my appointments"],
    };
  }

  if (intent === "VIEW_APPOINTMENTS") {
    const appointments = await getPatientUpcomingAppointments(context.patientId);
    updateConversationState(context.patientId, conversationId, { lastIntent: intent, extracted });
    return {
      conversationId,
      reply:
        appointments.length > 0
          ? `You have ${appointments.length} upcoming appointment${appointments.length === 1 ? "" : "s"} in HealthLink.`
          : "You can open your appointments to review upcoming bookings.",
      intent,
      riskLevel: "NONE",
      extracted,
      actions: [{ type: "OPEN_APPOINTMENTS", label: "View My Appointments" }],
      suggestions: ["View my appointments", "Book a doctor", "What is my queue number?"],
    };
  }

  if (intent === "VIEW_PRESCRIPTION") {
    const prescriptions = await getPatientActivePrescriptions(context.patientId);
    updateConversationState(context.patientId, conversationId, { lastIntent: intent, extracted });
    return {
      conversationId,
      reply:
        prescriptions.length > 0
          ? `You have ${prescriptions.length} active prescription${prescriptions.length === 1 ? "" : "s"} in HealthLink.`
          : "You can open your prescriptions to review medicines and QR details.",
      intent,
      riskLevel: "NONE",
      extracted,
      actions: [{ type: "OPEN_PRESCRIPTIONS", label: "Open Prescriptions" }],
      suggestions: ["Show my prescriptions", "View my medical records", "Book a doctor"],
    };
  }

  if (intent === "VIEW_MEDICAL_RECORDS") {
    await getPatientMedicalHistorySummary(context.patientId);
    updateConversationState(context.patientId, conversationId, { lastIntent: intent, extracted });
    return {
      conversationId,
      reply: "Your medical history screen shows previous consultations, reports, and prescription-linked records.",
      intent,
      riskLevel: "NONE",
      extracted,
      actions: [{ type: "OPEN_MEDICAL_RECORDS", label: "Open Medical Records" }],
      suggestions: ["Show my medical records", "Show my prescriptions", "View my appointments"],
    };
  }

  if (intent === "PRESCRIPTION_FULFILLMENT") {
    const options = await getPatientPrescriptionOrderOptions(context.patientId, extracted.prescriptionId);
    updateConversationState(context.patientId, conversationId, { lastIntent: intent, extracted });
    return {
      conversationId,
      reply:
        options.length > 0
          ? "You can open your prescriptions, choose an active prescription, and send it to a pharmacy for fulfilment."
          : "Open your prescriptions to choose an active prescription and continue with pharmacy fulfilment.",
      intent,
      riskLevel: "NONE",
      extracted,
      actions: [
        { type: "OPEN_PRESCRIPTIONS", label: "Open Prescriptions" },
        {
          type: "OPEN_PRESCRIPTION_ORDER",
          label: "Start Prescription Order",
          payload: extracted.prescriptionId ? { prescriptionId: extracted.prescriptionId } : undefined,
        },
      ],
      suggestions: ["Show my prescriptions", "Start prescription order", "Search pharmacy"],
    };
  }

  if (intent === "PHARMACY_ORDER_STATUS") {
    const orders = await getPatientPharmacyOrders(context.patientId);
    updateConversationState(context.patientId, conversationId, { lastIntent: intent, extracted });
    return {
      conversationId,
      reply:
        orders.length > 0
          ? `You have ${orders.length} recent pharmacy order${orders.length === 1 ? "" : "s"} in HealthLink.`
          : "You can open your orders to check pharmacy delivery, pickup, and order status.",
      intent,
      riskLevel: "NONE",
      extracted,
      actions: [
        { type: "OPEN_ORDER_STATUS", label: "Open Orders" },
        { type: "OPEN_CART", label: "Open Cart" },
      ],
      suggestions: ["Track my order", "Open cart", "Search pharmacy"],
    };
  }

  if (intent === "MEDICINE_AVAILABILITY" || intent === "PHARMACY_SEARCH" || intent === "HEALTH_PRODUCT_GUIDANCE") {
    const medicineSafety = classifyMedicineSafety(normalized, extracted.medicineName);
    const pharmacyHint = inferPharmacyCategory(normalized);
    const pharmacyExtracted = mergeExtracted(extracted, {
      medicineCategory: extracted.medicineCategory || pharmacyHint?.category,
    });

    if (medicineSafety.level === "CONTROLLED_OR_UNSUPPORTED") {
      return {
        conversationId,
        reply: "I can’t help with ordering controlled or restricted medicines through chat. Please consult a doctor or pharmacist.",
        intent,
        riskLevel: "MODERATE",
        extracted: pharmacyExtracted,
        actions: [
          buildMedicineDoctorAction(pharmacyExtracted.specialty),
          { type: "OPEN_PRESCRIPTIONS", label: "View Prescriptions" },
        ],
        suggestions: ["Book a doctor", "Show my prescriptions", "Search pharmacy"],
      };
    }

    if (medicineSafety.level === "PRESCRIPTION_REQUIRED") {
      return {
        conversationId,
        reply:
          "This medicine may require a valid prescription or pharmacist/doctor review. I can help you view your prescriptions or book a doctor.",
        intent,
        riskLevel: "MODERATE",
        extracted: pharmacyExtracted,
        actions: [
          { type: "OPEN_PRESCRIPTIONS", label: "View Prescriptions" },
          buildMedicineDoctorAction(pharmacyExtracted.specialty),
          buildPharmacySearchAction(pharmacyExtracted),
        ],
        suggestions: ["Show my prescriptions", "Book a doctor", "Search pharmacy"],
      };
    }

    const searchQuery =
      pharmacyExtracted.medicineName ||
      normalizeMedicineQuery(normalized) ||
      pharmacyExtracted.medicineCategory ||
      pharmacyExtracted.symptoms?.[0];
    const medicineResults = await searchPharmacyProducts({
      query: searchQuery,
      medicineName: pharmacyExtracted.medicineName,
      category: pharmacyExtracted.medicineCategory,
      symptom: pharmacyExtracted.symptoms?.[0],
      requiresPrescription: false,
      limit: 6,
    });
    const pharmacyResults = await searchPharmaciesWithProduct({
      medicineName: pharmacyExtracted.medicineName || pharmacyExtracted.medicineCategory,
    });

    if (intent === "HEALTH_PRODUCT_GUIDANCE") {
      updateConversationState(context.patientId, conversationId, {
        lastIntent: intent,
        extracted: pharmacyExtracted,
      });
      return {
        conversationId,
        reply:
          "I found items related to your health concern. Please follow label instructions and consult a pharmacist or doctor if symptoms continue.",
        intent,
        riskLevel: "LOW",
        extracted: pharmacyExtracted,
        actions: [
          ...(medicineResults.length > 0
            ? [{ type: "SHOW_MEDICINE_RESULTS", label: "Related items" } as AssistantAction]
            : []),
          ...(pharmacyResults.length > 0
            ? [{ type: "SHOW_PHARMACY_RESULTS", label: "Nearby pharmacies" } as AssistantAction]
            : []),
          buildDoctorSearchAction({
            specialty: pharmacyExtracted.specialty || "General Physician",
            symptoms: pharmacyExtracted.symptoms,
          }),
          buildPharmacySearchAction(pharmacyExtracted),
        ],
        suggestions: ["Find doctor", "Search pharmacy", "Ask another question"],
        medicineResults,
        pharmacyResults,
      };
    }

    updateConversationState(context.patientId, conversationId, {
      lastIntent: intent,
      extracted: pharmacyExtracted,
    });
    return {
      conversationId,
      reply:
        medicineResults.length > 0
          ? `I found pharmacy items related to ${pharmacyExtracted.medicineName || pharmacyExtracted.medicineCategory || searchQuery || "your request"}. Please follow label instructions and ask a pharmacist or doctor if you are unsure.`
          : "I could not find matching pharmacy items right now. You can open pharmacy search or book a doctor for more help.",
      intent,
      riskLevel: medicineSafety.level === "OTC_CAUTION" ? "LOW" : "NONE",
      extracted: pharmacyExtracted,
      actions: [
        ...(medicineResults.length > 0
          ? [{ type: "SHOW_MEDICINE_RESULTS", label: "Available items" } as AssistantAction]
          : []),
        ...(pharmacyResults.length > 0
          ? [{ type: "SHOW_PHARMACY_RESULTS", label: "Matching pharmacies" } as AssistantAction]
          : []),
        buildPharmacySearchAction(pharmacyExtracted),
        ...(pharmacyExtracted.specialty ? [buildMedicineDoctorAction(pharmacyExtracted.specialty)] : []),
      ],
      suggestions:
        intent === "MEDICINE_AVAILABILITY"
          ? ["Search pharmacy", "Book a doctor", "Show my prescriptions"]
          : ["Search pharmacy", "Find doctor", "Show my prescriptions"],
      medicineResults,
      pharmacyResults,
    };
  }

  if (intent === "BOOK_APPOINTMENT" || intent === "SEARCH_DOCTORS") {
    if (!extracted.specialty) {
      const followUpQuestion =
        ai?.needsFollowUp && ai.followUpQuestion
          ? ai.followUpQuestion
          : "Sure. What symptoms are you having, or what type of doctor do you need?";
      updateConversationState(context.patientId, conversationId, {
        lastIntent: "BOOK_APPOINTMENT",
        extracted,
        pendingBooking: { ...state.pendingBooking, ...extracted },
      });
      return {
        conversationId,
        reply: followUpQuestion,
        intent: "BOOK_APPOINTMENT",
        riskLevel: "NONE",
        extracted,
        actions: [{ type: "ASK_FOLLOW_UP", label: "Tell MediMate more" }],
        suggestions: ["I have fever", "Book a dentist tomorrow", "My child has cough"],
      };
    }

    const sessions = await searchDoctorSessions({
      specialty: extracted.specialty,
      preferredDate: extracted.preferredDate,
      preferredTime: extracted.preferredTime,
      medicalCenterName: extracted.medicalCenterName,
    });
    const pendingBooking = await createAppointmentDraft(state, {
      specialty: extracted.specialty,
      symptoms: extracted.symptoms,
      preferredDate: extracted.preferredDate,
      preferredTime: extracted.preferredTime,
      selectedSessionId: undefined,
      selectedDoctorName: extracted.doctorName,
      selectedMedicalCenterName: extracted.medicalCenterName,
    });
    updateConversationState(context.patientId, conversationId, {
      lastIntent: "BOOK_APPOINTMENT",
      extracted,
      pendingBooking,
    });
    return {
      conversationId,
      reply: `I can help you find a suitable doctor. Based on your message, ${extracted.specialty} may be a good starting point.`,
      intent: "BOOK_APPOINTMENT",
      riskLevel: extracted.symptoms?.length ? "MODERATE" : "NONE",
      extracted,
      actions:
        sessions.length > 0
          ? [
              { type: "SHOW_SESSION_RESULTS", label: "Available sessions", payload: { sessions } },
              buildDoctorSearchAction(extracted),
            ]
          : [buildDoctorSearchAction(extracted)],
      suggestions: [`Find ${extracted.specialty}`, "Show available doctors", "View my appointments"],
    };
  }

  if (intent === "UNKNOWN" && ai?.needsFollowUp && ai.followUpQuestion) {
    updateConversationState(context.patientId, conversationId, { lastIntent: "UNKNOWN", extracted });
    return {
      conversationId,
      reply: ai.followUpQuestion,
      intent,
      riskLevel: "NONE",
      extracted,
      actions: [{ type: "ASK_FOLLOW_UP", label: "Tell MediMate more" }],
      suggestions: ["Book a doctor", "Search pharmacy", "Show my prescriptions"],
    };
  }

  if (extracted.symptoms?.length) {
    updateConversationState(context.patientId, conversationId, {
      lastIntent: "GENERAL_HEALTH_INFO",
      extracted,
      pendingBooking: { ...state.pendingBooking, ...extracted },
    });
    return {
      conversationId,
      reply: buildHealthReply(normalized, extracted.specialty),
      intent: "GENERAL_HEALTH_INFO",
      riskLevel,
      extracted,
      actions: [buildDoctorSearchAction(extracted)],
      suggestions: [`Find ${extracted.specialty || "General Physician"}`, "Show available doctors", "Book a doctor"],
    };
  }

  updateConversationState(context.patientId, conversationId, { lastIntent: "UNKNOWN", extracted });
  return buildUnknownResponse(conversationId);
};
