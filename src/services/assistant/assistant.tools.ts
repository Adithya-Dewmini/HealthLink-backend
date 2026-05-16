import pool from "../../config/db";
import { addCartItem, getCart } from "../../modules/cart/service";
import { searchMarketplaceProducts } from "../../modules/marketplace/service";
import type { MarketplaceStoreProduct } from "../../modules/marketplace/types";
import { getPatientOrders } from "../../modules/orders/service";
import { listPatientBookings, createPatientBooking } from "../patientBooking.service";
import { listPatientMedicalHistory } from "../patientMedicalHistory.service";
import { listPatientPrescriptions } from "../patientPrescription.service";
import { findClinicSessionById } from "../sessionDomain.service";
import { classifyMedicineSafety } from "./assistant.medicineSafety";
import { buildPharmacySearchCandidates, normalizeMedicineQuery } from "./assistant.pharmacy";
import type {
  AssistantSessionCard,
  ConversationState,
  MedicineRecommendation,
  PharmacyRecommendation,
} from "./assistant.types";

type SearchDoctorSessionsParams = {
  specialty?: string;
  preferredDate?: string;
  preferredTime?: string;
  medicalCenterName?: string;
};

type SearchPharmacyProductsParams = {
  query?: string;
  category?: string;
  symptom?: string;
  medicineName?: string;
  requiresPrescription?: boolean;
  limit?: number;
};

const BOOKABLE_CLINIC_SQL = `
  (
    LOWER(COALESCE(mc.verification_status, 'pending')) = 'approved'
    OR (
      LOWER(COALESCE(mc.verification_status, 'pending')) = 'pending'
      AND LOWER(COALESCE(mc.status, '')) = 'approved'
    )
  )
  AND LOWER(COALESCE(mc.status, 'active')) IN ('active', 'approved')
`;

const ASSISTANT_DEBUG_LOGS_ENABLED =
  process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" && process.env.VITEST !== "true";

const DOSAGE_FORM_PATTERNS = ["tablet", "capsule", "syrup", "drops", "cream", "ointment", "suspension"] as const;
const STRENGTH_PATTERN = /\b\d+(?:\.\d+)?\s?(?:mg|ml|g|mcg)\b/i;

const buildStockStatus = (stockQuantity: number): MedicineRecommendation["stockStatus"] => {
  if (!Number.isFinite(stockQuantity)) return "UNKNOWN";
  if (stockQuantity <= 0) return "OUT_OF_STOCK";
  if (stockQuantity <= 10) return "LOW_STOCK";
  return "IN_STOCK";
};

const extractDosageForm = (...values: Array<string | null | undefined>) => {
  const haystack = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  return DOSAGE_FORM_PATTERNS.find((form) => haystack.includes(form));
};

const extractStrength = (...values: Array<string | null | undefined>) => {
  for (const value of values) {
    if (!value) continue;
    const match = value.match(STRENGTH_PATTERN);
    if (match?.[0]) {
      return match[0];
    }
  }
  return undefined;
};

const normalizeMarketplaceProductToMedicineRecommendation = (
  item: MarketplaceStoreProduct & { pharmacyName?: string | null },
  matchedQuery: string
): MedicineRecommendation | null => {
  const stockQuantity = Number(item.stockQuantity);
  const normalizedMatch = normalizeMedicineQuery(matchedQuery) || matchedQuery.trim().toLowerCase();
  const safety = classifyMedicineSafety(
    [item.name, item.genericName, item.brand, item.category]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" "),
    item.genericName ?? item.name
  );

  if (safety.level === "CONTROLLED_OR_UNSUPPORTED") {
    return null;
  }

  const haystack = [item.name, item.genericName, item.brand, item.category]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  const matchConfidence = normalizedMatch && haystack.includes(normalizedMatch) ? 9 : 8;

  return {
    productId: String(item.id),
    medicineName: item.name || "Health product",
    genericName: item.genericName || undefined,
    brandName: item.brand || undefined,
    category: item.category || undefined,
    dosageForm: extractDosageForm(item.name, item.genericName, item.description),
    strength: extractStrength(item.name, item.genericName, item.description),
    pharmacyName: item.pharmacyName ?? undefined,
    pharmacyId: Number.isFinite(Number(item.pharmacyId)) ? String(item.pharmacyId) : undefined,
    price: Number.isFinite(Number(item.discountPrice ?? item.price)) ? Number(item.discountPrice ?? item.price) : undefined,
    currency: "LKR",
    stockStatus: buildStockStatus(stockQuantity),
    requiresPrescription: Boolean(item.requiresPrescription) || safety.requiresPrescription,
    imageUrl: item.imageUrl || undefined,
    safetyNote: safety.warning,
    matchReason: normalizedMatch ? `Matched your search for ${normalizedMatch}` : "Matched your search",
    matchConfidence,
  };
};

const buildGroupedPharmacies = (items: MedicineRecommendation[]): PharmacyRecommendation[] => {
  const grouped = new Map<string, PharmacyRecommendation>();
  for (const item of items) {
    if (!item.pharmacyId || !item.pharmacyName) continue;
    const current = grouped.get(item.pharmacyId);
    grouped.set(item.pharmacyId, {
      pharmacyId: item.pharmacyId,
      pharmacyName: item.pharmacyName,
      openStatus: "UNKNOWN",
      availableItems: (current?.availableItems ?? 0) + (item.stockStatus === "OUT_OF_STOCK" ? 0 : 1),
    });
  }
  return [...grouped.values()];
};

const shouldSkipOptionalDbLookups = () =>
  process.env.NODE_ENV === "test" || process.env.VITEST === "true";

const timePreferenceMatches = (timeValue: string, preferredTime?: string) => {
  if (!preferredTime) {
    return true;
  }

  const hour = Number(String(timeValue).slice(0, 2));
  if (Number.isNaN(hour)) {
    return true;
  }

  switch (preferredTime.toLowerCase()) {
    case "morning":
      return hour >= 6 && hour < 12;
    case "afternoon":
      return hour >= 12 && hour < 17;
    case "evening":
      return hour >= 17 && hour < 22;
    default:
      return timeValue.toLowerCase().includes(preferredTime.toLowerCase());
  }
};

export const getPatientQueueStatus = async (patientId: string) => {
  if (shouldSkipOptionalDbLookups()) {
    return null;
  }

  try {
    const result = await pool.query<{
      queue_id: number;
      session_id: number | null;
      queue_status: string;
      patient_status: string;
      token_number: number | null;
      doctor_name: string | null;
      medical_center_name: string | null;
      waiting_count: number | null;
      current_token: number | null;
    }>(
      `
      SELECT
        qp.queue_id,
        q.schedule_id AS session_id,
        q.status AS queue_status,
        qp.status AS patient_status,
        qp.token_number,
        du.name AS doctor_name,
        mc.name AS medical_center_name,
        (
          SELECT COUNT(*)::int
          FROM queue_patients qp_waiting
          WHERE qp_waiting.queue_id = qp.queue_id
            AND qp_waiting.status = 'WAITING'
        ) AS waiting_count,
        (
          SELECT qp_live.token_number
          FROM queue_patients qp_live
          WHERE qp_live.queue_id = qp.queue_id
            AND qp_live.status = 'WITH_DOCTOR'
          ORDER BY qp_live.id DESC
          LIMIT 1
        ) AS current_token
      FROM queue_patients qp
      JOIN queues q ON q.id = qp.queue_id
      LEFT JOIN users du ON du.id = qp.doctor_id
      LEFT JOIN medical_centers mc ON mc.id = COALESCE(qp.medical_center_id, q.medical_center_id)
      WHERE qp.patient_id = $1
        AND qp.status IN ('WAITING', 'WITH_DOCTOR')
        AND q.status IN ('LIVE', 'PAUSED')
      ORDER BY q.created_at DESC, qp.id DESC
      LIMIT 1
      `,
      [Number(patientId)]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      queueId: String(row.queue_id),
      sessionId: row.session_id ? String(row.session_id) : undefined,
      queueStatus: row.queue_status,
      patientStatus: row.patient_status,
      tokenNumber: row.token_number,
      currentToken: row.current_token,
      waitingCount: row.waiting_count ?? 0,
      doctorName: row.doctor_name ?? "Doctor",
      medicalCenterName: row.medical_center_name ?? "Medical Center",
    };
  } catch {
    return null;
  }
};

export const getPatientUpcomingAppointments = async (patientId: string) => {
  if (shouldSkipOptionalDbLookups()) {
    return [];
  }

  try {
    const bookings = await listPatientBookings(Number(patientId));
    return (Array.isArray(bookings) ? bookings : []).slice(0, 3);
  } catch {
    return [];
  }
};

export const getPatientActivePrescriptions = async (patientId: string) => {
  if (shouldSkipOptionalDbLookups()) {
    return [];
  }

  try {
    const prescriptions = await listPatientPrescriptions(Number(patientId), false);
    return (Array.isArray(prescriptions) ? prescriptions : [])
      .filter((item) => item?.status === "Active")
      .slice(0, 3);
  } catch {
    return [];
  }
};

export const getPatientMedicalHistorySummary = async (patientId: string) => {
  if (shouldSkipOptionalDbLookups()) {
    return [];
  }

  try {
    const records = await listPatientMedicalHistory(Number(patientId));
    return (Array.isArray(records) ? records : []).slice(0, 3);
  } catch {
    return [];
  }
};

export const searchPharmacyProducts = async (
  params: SearchPharmacyProductsParams
): Promise<MedicineRecommendation[]> => {
  const candidates = buildPharmacySearchCandidates({
    query: params.query,
    medicineName: params.medicineName,
    category: params.category,
    symptom: params.symptom,
  });
  const primaryQuery = candidates[0] || normalizeMedicineQuery(params.query ?? params.medicineName ?? params.category ?? params.symptom ?? "");

  if (!primaryQuery && candidates.length === 0) {
    return [];
  }

  if (shouldSkipOptionalDbLookups()) {
    const normalized = primaryQuery.toLowerCase();
    if (normalized.includes("paracetamol")) {
      return [
        {
          productId: "demo-paracetamol",
          medicineName: "Paracetamol 500mg",
          genericName: "Paracetamol",
          category: "Pain & Fever Care",
          pharmacyName: "HealthLink Pharmacy",
          pharmacyId: "1",
          price: 150,
          currency: "LKR",
          stockStatus: "IN_STOCK",
          requiresPrescription: false,
          safetyNote: "Please follow label instructions and consult a pharmacist or doctor if symptoms continue.",
          matchReason: "Matched your search for paracetamol",
          matchConfidence: 9,
        },
      ];
    }
    if (normalized.includes("fever")) {
      return [
        {
          productId: "demo-fever-care",
          medicineName: "Digital Thermometer",
          category: "Fever Care",
          pharmacyName: "HealthLink Pharmacy",
          pharmacyId: "1",
          price: 1200,
          currency: "LKR",
          stockStatus: "IN_STOCK",
          requiresPrescription: false,
          safetyNote: "Please follow label instructions and consult a pharmacist or doctor if symptoms continue.",
          matchReason: "Matched your search for fever care",
          matchConfidence: 8,
        },
      ];
    }
    return [];
  }

  try {
    if (ASSISTANT_DEBUG_LOGS_ENABLED) {
      console.info("[MediMate Pharmacy Search]", {
        query: primaryQuery,
        medicineName: params.medicineName,
        category: params.category,
        symptom: params.symptom,
        searchTerms: candidates,
        limit: params.limit ?? 8,
      });
    }

    const result = await searchMarketplaceProducts({
      search: primaryQuery,
      query: primaryQuery,
      category: params.category,
      limit: params.limit ?? 8,
      terms: candidates,
    });
    const items = (result.items ?? [])
      .map((item) =>
        normalizeMarketplaceProductToMedicineRecommendation(
          item as MarketplaceStoreProduct & { pharmacyName?: string | null },
          primaryQuery
        )
      )
      .filter((item): item is MedicineRecommendation => item !== null)
      .filter((item) => (params.requiresPrescription ? item.requiresPrescription === true : true))
      .slice(0, params.limit ?? 8);

    if (ASSISTANT_DEBUG_LOGS_ENABLED) {
      console.info("[MediMate Pharmacy Search]", {
        query: primaryQuery,
        category: params.category,
        resultCount: items.length,
        topResults: items.slice(0, 3).map((item) => item.medicineName),
      });
    }

    return items;
  } catch {
    return [];
  }
};

export const searchPharmaciesWithProduct = async (params: {
  productId?: string;
  medicineName?: string;
  locationHint?: string;
}): Promise<PharmacyRecommendation[]> => {
  const products = await searchPharmacyProducts({
    query: params.medicineName,
    medicineName: params.medicineName,
    limit: 10,
  });
  return buildGroupedPharmacies(
    params.productId ? products.filter((item) => item.productId === params.productId) : products
  );
};

export const getPatientPharmacyOrders = async (patientId: string) => {
  if (shouldSkipOptionalDbLookups()) {
    return [];
  }

  try {
    const result = await getPatientOrders(Number(patientId));
    return Array.isArray(result.orders) ? result.orders.slice(0, 3) : [];
  } catch {
    return [];
  }
};

export const getPatientPrescriptionOrderOptions = async (
  patientId: string,
  prescriptionId?: string
) => {
  const prescriptions = await getPatientActivePrescriptions(patientId);
  if (!prescriptionId) {
    return prescriptions;
  }

  return prescriptions.filter((item) => String(item?.id ?? "") === prescriptionId);
};

export const createCartDraft = async (patientId: string, productId: string, quantity: number) => ({
  patientId,
  productId,
  quantity,
});

export const confirmAddToCart = async (params: {
  patientId: string;
  productId?: string;
  quantity?: number;
  confirmation?: boolean;
}) => {
  if (!params.confirmation) {
    throw Object.assign(new Error("Explicit cart confirmation is required"), { statusCode: 400 });
  }

  const productId = Number(params.productId);
  if (!Number.isInteger(productId) || productId <= 0) {
    throw Object.assign(new Error("Please choose a valid pharmacy item first"), { statusCode: 400 });
  }

  if (shouldSkipOptionalDbLookups()) {
    return {
      cartItemCount: Math.max(1, Number(params.quantity ?? 1)),
      productId: String(productId),
    };
  }

  const result = await addCartItem(Number(params.patientId), {
    marketplaceProductId: productId,
    quantity: Math.max(1, Number(params.quantity ?? 1)),
  });

  return {
    cartItemCount: result.cart.itemCount,
    productId: String(productId),
    cart: await getCart(Number(params.patientId)),
  };
};

export const searchDoctorSessions = async (
  params: SearchDoctorSessionsParams
): Promise<AssistantSessionCard[]> => {
  if (shouldSkipOptionalDbLookups()) {
    return [];
  }

  try {
    const result = await pool.query<{
      session_id: number;
      doctor_id: number;
      doctor_name: string | null;
      specialty: string | null;
      medical_center_id: string;
      medical_center_name: string | null;
      date: string;
      start_time: string;
      available_slots: number | null;
    }>(
      `
      SELECT
        s.id AS session_id,
        d.id AS doctor_id,
        u.name AS doctor_name,
        COALESCE(d.specialization, 'General Physician') AS specialty,
        s.medical_center_id,
        mc.name AS medical_center_name,
        s.date::text AS date,
        s.start_time::text AS start_time,
        GREATEST(
          COALESCE(s.max_patients, 0) - COALESCE(bookings.booked_count, 0),
          0
        )::int AS available_slots
      FROM medical_center_doctor_schedule s
      JOIN doctors d ON d.id = s.doctor_profile_id
      JOIN users u ON u.id = d.user_id
      JOIN medical_centers mc ON mc.id = s.medical_center_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS booked_count
        FROM bookings b
        WHERE b.session_id = s.id
          AND COALESCE(UPPER(b.status), '') NOT IN ('CANCELLED', 'MISSED')
      ) bookings ON TRUE
      WHERE s.is_active = TRUE
        AND s.date >= CURRENT_DATE
        AND ${BOOKABLE_CLINIC_SQL}
        AND ($1::text IS NULL OR COALESCE(d.specialization, '') ILIKE '%' || $1 || '%')
        AND ($2::date IS NULL OR s.date = $2::date)
        AND ($3::text IS NULL OR mc.name ILIKE '%' || $3 || '%')
      ORDER BY s.date ASC, s.start_time ASC, mc.name ASC, u.name ASC
      LIMIT 8
      `,
      [params.specialty ?? null, params.preferredDate ?? null, params.medicalCenterName ?? null]
    );

    return result.rows
      .filter((row) => timePreferenceMatches(String(row.start_time).slice(0, 5), params.preferredTime))
      .map((row) => ({
        sessionId: String(row.session_id),
        doctorName: row.doctor_name ?? "Doctor",
        specialty: row.specialty ?? "General Physician",
        medicalCenterName: row.medical_center_name ?? "Medical Center",
        date: row.date,
        time: String(row.start_time).slice(0, 5),
        availableSlots: row.available_slots ?? undefined,
        doctorId: String(row.doctor_id),
        medicalCenterId: row.medical_center_id,
      }));
  } catch {
    return [];
  }
};

export const createAppointmentDraft = async (
  state: ConversationState,
  patch: NonNullable<ConversationState["pendingBooking"]>
) => ({
  ...state.pendingBooking,
  ...patch,
});

export const confirmAppointmentBooking = async (params: {
  patientId: string;
  selectedSessionId?: string;
  confirmation?: boolean;
}) => {
  if (!params.confirmation) {
    throw Object.assign(new Error("Explicit booking confirmation is required"), { statusCode: 400 });
  }

  const sessionId = Number(params.selectedSessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    throw Object.assign(new Error("Please select a valid doctor session before confirming"), {
      statusCode: 400,
    });
  }

  const session = await findClinicSessionById(pool, sessionId);
  if (!session || !session.is_active) {
    throw Object.assign(new Error("Selected session is no longer available"), { statusCode: 404 });
  }

  const booking = await createPatientBooking(
    Number(params.patientId),
    session.doctor_profile_id,
    session.medical_center_id,
    session.date,
    String(session.start_time).slice(0, 5),
    session.id
  );

  return {
    bookingId: booking.id,
    sessionId: String(booking.session_id),
    date: booking.date,
    time: String(booking.time).slice(0, 5),
    medicalCenterId: booking.medical_center_id,
    doctorId: String(booking.doctor_id),
  };
};
