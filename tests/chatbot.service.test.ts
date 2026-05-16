import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { searchMarketplaceProducts } from "../src/modules/marketplace/service";
import * as assistantTools from "../src/services/assistant/assistant.tools";
import { classifyMedicineSafety } from "../src/services/assistant/assistant.medicineSafety";
import { inferPharmacyCategory, normalizeMedicineQuery } from "../src/services/assistant/assistant.pharmacy";
import {
  buildPatientChatbotResponse,
  detectChatbotIntent,
  detectSpecialtyFromMessage,
} from "../src/services/chatbot.service";

vi.mock("../src/modules/marketplace/service", () => ({
  searchMarketplaceProducts: vi.fn(),
}));

const mockedSearchMarketplaceProducts = vi.mocked(searchMarketplaceProducts);
const originalNodeEnv = process.env.NODE_ENV;
const originalVitestEnv = process.env.VITEST;

describe("chatbot service", () => {
  beforeEach(() => {
    mockedSearchMarketplaceProducts.mockReset();
    process.env.NODE_ENV = "test";
    process.env.VITEST = "true";
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.VITEST = originalVitestEnv;
  });

  it("normalizeMedicineQuery strips filler words for paracetamol", () => {
    expect(normalizeMedicineQuery("do you have paracetamol")).toBe("paracetamol");
  });

  it("normalizeMedicineQuery maps panadol to paracetamol", () => {
    expect(normalizeMedicineQuery("do you have panadol")).toBe("paracetamol");
  });

  it("doctor phrases do not become medicine queries", () => {
    expect(normalizeMedicineQuery("show available doctors")).toBe("");
  });

  it("doctors does not match ors pharmacy category", () => {
    expect(inferPharmacyCategory("show available doctors")).toBeUndefined();
  });

  it("paracetamol stays OTC caution and does not require prescription", () => {
    expect(classifyMedicineSafety("do you have paracetamol", "paracetamol")).toMatchObject({
      level: "OTC_CAUTION",
      requiresPrescription: false,
    });
  });

  it("greeting returns SMALL_TALK", async () => {
    const response = await buildPatientChatbotResponse("hi", { patientId: "7" });
    expect(response.intent).toBe("SMALL_TALK");
  });

  it("open booking asks follow-up", async () => {
    const response = await buildPatientChatbotResponse("I want to book a doctor", { patientId: "7" });
    expect(detectChatbotIntent("I want to book a doctor")).toBe("BOOK_APPOINTMENT");
    expect(response.actions[0]?.type).toBe("ASK_FOLLOW_UP");
  });

  it("show available doctors stays in doctor intent", async () => {
    const response = await buildPatientChatbotResponse("Show available doctors", { patientId: "7" });
    expect(detectChatbotIntent("Show available doctors")).toBe("SEARCH_DOCTORS");
    expect(["SEARCH_DOCTORS", "BOOK_APPOINTMENT"]).toContain(response.intent);
    expect(response.reply.toLowerCase()).not.toContain("pharmacy items");
  });

  it("fever suggests General Physician", async () => {
    const response = await buildPatientChatbotResponse("I have fever", { patientId: "7" });
    expect(detectSpecialtyFromMessage("I have fever and body pain")).toBe("General Physician");
    expect(response.extracted.specialty).toBe("General Physician");
  });

  it("child cough suggests Pediatrician", async () => {
    const response = await buildPatientChatbotResponse("My child has cough", { patientId: "7" });
    expect(response.extracted.specialty).toBe("Pediatrician");
  });

  it("tooth pain suggests Dentist", async () => {
    const response = await buildPatientChatbotResponse("I have tooth pain", { patientId: "7" });
    expect(response.extracted.specialty).toBe("Dentist");
  });

  it("book dentist tomorrow evening extracts specialty/date/time", async () => {
    const response = await buildPatientChatbotResponse("Book dentist tomorrow evening", { patientId: "7" });
    expect(response.intent).toBe("BOOK_APPOINTMENT");
    expect(response.extracted.specialty).toBe("Dentist");
    expect(response.extracted.preferredTime).toBe("evening");
    expect(response.extracted.preferredDate).toBeTruthy();
  });

  it("emergency detected before booking", async () => {
    const response = await buildPatientChatbotResponse("There is chest pain and shortness of breath", {
      patientId: "7",
    });
    expect(response.intent).toBe("GENERAL_HEALTH_INFO");
    expect(response.riskLevel).toBe("URGENT");
    expect(response.actions[0]?.type).toBe("CALL_EMERGENCY");
  });

  it("queue returns OPEN_QUEUE", async () => {
    const response = await buildPatientChatbotResponse("What is my queue number?", { patientId: "7" });
    expect(response.intent).toBe("VIEW_QUEUE");
    expect(response.actions[0]?.type).toBe("OPEN_QUEUE");
  });

  it("prescriptions returns OPEN_PRESCRIPTIONS", async () => {
    const response = await buildPatientChatbotResponse("Show my prescriptions", { patientId: "7" });
    expect(response.intent).toBe("VIEW_PRESCRIPTION");
    expect(response.actions[0]?.type).toBe("OPEN_PRESCRIPTIONS");
  });

  it("medical records returns OPEN_MEDICAL_RECORDS", async () => {
    const response = await buildPatientChatbotResponse("Show my reports", { patientId: "7" });
    expect(response.intent).toBe("VIEW_MEDICAL_RECORDS");
    expect(response.actions[0]?.type).toBe("OPEN_MEDICAL_RECORDS");
  });

  it("select session returns CONFIRM_BOOKING action", async () => {
    const response = await buildPatientChatbotResponse("Selected this session", {
      patientId: "7",
      conversationId: "select-session-flow",
      actionPayload: {
        type: "SELECT_SESSION",
        sessionId: "123",
        session: {
          sessionId: "123",
          doctorName: "Dr Test",
          medicalCenterName: "HealthLink Center",
        },
      },
    });
    expect(response.intent).toBe("SELECT_SESSION");
    expect(response.actions[0]?.type).toBe("CONFIRM_BOOKING");
  });

  it("confirm booking without selectedSessionId does not book", async () => {
    const response = await buildPatientChatbotResponse("yes book it", {
      patientId: "7",
      conversationId: "confirm-without-session",
    });
    expect(response.intent).toBe("CONFIRM_BOOKING");
    expect(response.reply.toLowerCase()).toContain("choose a session");
  });

  it("confirm booking requires confirmation true", async () => {
    const response = await buildPatientChatbotResponse("Confirm booking", {
      patientId: "7",
      conversationId: "confirm-flag-required",
      actionPayload: {
        type: "CONFIRM_BOOKING",
        selectedSessionId: "22",
        confirmation: false,
      },
    });
    expect(response.intent).toBe("CONFIRM_BOOKING");
    expect(response.actions[0]?.requiresConfirmation).toBe(true);
  });

  it("confirm booking returns assistant reply when clinic is not approved", async () => {
    const confirmSpy = vi
      .spyOn(assistantTools, "confirmAppointmentBooking")
      .mockRejectedValueOnce(Object.assign(new Error("Medical center is not approved for bookings"), { statusCode: 403 }));

    const response = await buildPatientChatbotResponse("Confirm booking", {
      patientId: "7",
      conversationId: "confirm-unapproved-clinic",
      actionPayload: {
        type: "CONFIRM_BOOKING",
        selectedSessionId: "256",
        confirmation: true,
      },
    });

    expect(response.intent).toBe("CONFIRM_BOOKING");
    expect(response.reply.toLowerCase()).toContain("not currently approved");
    expect(response.actions.some((action) => action.type === "OPEN_DOCTOR_SEARCH")).toBe(true);

    confirmSpy.mockRestore();
  });

  it("AI disabled fallback still works", async () => {
    const response = await buildPatientChatbotResponse("I have tooth pain", { patientId: "7" });
    expect(response.extracted.specialty).toBe("Dentist");
    expect(response.intent).toBe("GENERAL_HEALTH_INFO");
  });

  it("Do you have paracetamol? returns pharmacy search results", async () => {
    const response = await buildPatientChatbotResponse("Do you have paracetamol?", { patientId: "7" });
    expect(["MEDICINE_AVAILABILITY", "PHARMACY_SEARCH"]).toContain(response.intent);
    expect(response.medicineResults?.length ?? 0).toBeGreaterThan(0);
  });

  it("marketplace-backed paracetamol search returns medicineResults without false fallback", async () => {
    process.env.NODE_ENV = "development";
    process.env.VITEST = "false";
    mockedSearchMarketplaceProducts.mockResolvedValue({
      items: [
        {
          id: "101",
          inventoryItemId: 77,
          name: "Paracetamol 500mg Tablet",
          genericName: "Paracetamol",
          brand: "Panadol",
          description: "Pain and fever relief tablets",
          category: "Pain & Fever Care",
          imageUrl: null,
          price: 120,
          discountPrice: null,
          requiresPrescription: false,
          isFeatured: false,
          isActive: true,
          inStock: true,
          stockQuantity: 5,
          pharmacyId: 9,
          pharmacyName: "City Pharmacy",
        },
      ],
    } as never);

    const response = await buildPatientChatbotResponse("Do you have paracetamol?", { patientId: "7" });

    expect(mockedSearchMarketplaceProducts).toHaveBeenCalled();
    expect(response.intent).toBe("MEDICINE_AVAILABILITY");
    expect(response.medicineResults?.length ?? 0).toBeGreaterThan(0);
    expect(response.medicineResults?.[0]).toMatchObject({
      medicineName: "Paracetamol 500mg Tablet",
      genericName: "Paracetamol",
      stockStatus: "LOW_STOCK",
      requiresPrescription: false,
      matchReason: "Matched your search for paracetamol",
    });
    expect(response.actions.some((action) => action.type === "SHOW_MEDICINE_RESULTS")).toBe(true);
    expect(response.actions.some((action) => action.type === "OPEN_PHARMACY_SEARCH")).toBe(true);
    expect(response.reply).not.toContain("I could not find matching pharmacy items right now");
  });

  it("What can I get for fever? returns product guidance with doctor and pharmacy actions", async () => {
    const response = await buildPatientChatbotResponse("What can I get for fever?", { patientId: "7" });
    expect(response.intent).toBe("HEALTH_PRODUCT_GUIDANCE");
    expect(response.actions.some((action) => action.type === "OPEN_DOCTOR_SEARCH")).toBe(true);
    expect(response.actions.some((action) => action.type === "OPEN_PHARMACY_SEARCH")).toBe(true);
  });

  it("I need antibiotics does not return add to cart and returns prescription warning", async () => {
    const response = await buildPatientChatbotResponse("I need antibiotics", { patientId: "7" });
    expect(response.reply.toLowerCase()).toContain("prescription");
    expect(response.actions.some((action) => action.type === "CONFIRM_ADD_TO_CART")).toBe(false);
  });

  it("Show my prescription medicines returns prescription fulfillment", async () => {
    const response = await buildPatientChatbotResponse("Show my prescription medicines", { patientId: "7" });
    expect(response.intent).toBe("PRESCRIPTION_FULFILLMENT");
    expect(response.actions.some((action) => action.type === "OPEN_PRESCRIPTIONS")).toBe(true);
  });

  it("Where is my medicine order? returns pharmacy order status", async () => {
    const response = await buildPatientChatbotResponse("Where is my medicine order?", { patientId: "7" });
    expect(response.intent).toBe("PHARMACY_ORDER_STATUS");
    expect(response.actions.some((action) => action.type === "OPEN_ORDER_STATUS")).toBe(true);
  });

  it("ADD_TO_CART action requires confirmation", async () => {
    const response = await buildPatientChatbotResponse("Add this item to cart", {
      patientId: "7",
      actionPayload: {
        type: "ADD_TO_CART",
        productId: "10",
        quantity: 1,
      },
    });
    expect(response.intent).toBe("ADD_TO_CART_DRAFT");
    expect(response.actions[0]?.type).toBe("CONFIRM_ADD_TO_CART");
    expect(response.actions[0]?.requiresConfirmation).toBe(true);
  });

  it("CONFIRM_ADD_TO_CART requires confirmation true", async () => {
    const response = await buildPatientChatbotResponse("Confirm add to cart", {
      patientId: "7",
      actionPayload: {
        type: "CONFIRM_ADD_TO_CART",
        productId: "10",
        quantity: 1,
        confirmation: false,
      },
    });
    expect(response.intent).toBe("ADD_TO_CART_DRAFT");
    expect(response.actions[0]?.requiresConfirmation).toBe(true);
  });

  it("prescription-required medicine cannot be directly added to cart", async () => {
    const response = await buildPatientChatbotResponse("Add this item to cart", {
      patientId: "7",
      actionPayload: {
        type: "ADD_TO_CART",
        productId: "88",
        quantity: 1,
        requiresPrescription: true,
      },
    });
    expect(response.reply.toLowerCase()).toContain("prescription");
    expect(response.actions.some((action) => action.type === "CONFIRM_ADD_TO_CART")).toBe(false);
  });

  it("emergency symptom overrides pharmacy product results", async () => {
    const response = await buildPatientChatbotResponse("I need medicine for chest pain and shortness of breath", {
      patientId: "7",
    });
    expect(response.riskLevel).toBe("URGENT");
    expect(response.medicineResults ?? []).toHaveLength(0);
  });
});
