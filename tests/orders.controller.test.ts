import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, createMockResponse } from "./helpers/http";

vi.mock("../src/services/verification.service", () => ({
  assertVerifiedPharmacyForUser: vi.fn(),
}));
vi.mock("../src/services/notification.service", () => ({
  createNotificationAndPush: vi.fn(),
  getPharmacyMemberUserIds: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/services/realtime.service", () => ({
  emitOrderCreated: vi.fn(),
  emitOrderUpdated: vi.fn(),
  emitPrescriptionUpdated: vi.fn(),
}));
vi.mock("../src/services/audit.service", () => ({
  createAuditLog: vi.fn(),
  getAuditRequestContext: vi.fn(() => ({
    actorUserId: 7,
    actorRole: "patient",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  })),
}));
vi.mock("../src/modules/activity/service", () => ({
  getPatientOrderTimeline: vi.fn(),
  recordActivityLog: vi.fn(),
}));
vi.mock("../src/modules/orders/service", () => ({
  checkoutCart: vi.fn(),
  getPatientOrderDetails: vi.fn(),
  getPatientOrders: vi.fn(),
  getPharmacyOrderDetails: vi.fn(),
  getPharmacyOrders: vi.fn(),
  updatePharmacyOrderStatus: vi.fn(),
}));

import {
  checkoutController,
  updatePharmacyOrderStatusController,
} from "../src/modules/orders/controller";
import {
  checkoutCart,
  updatePharmacyOrderStatus,
} from "../src/modules/orders/service";
import { createAuditLog } from "../src/services/audit.service";

describe("orders controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes an audit log when checkout succeeds", async () => {
    vi.mocked(checkoutCart).mockResolvedValue({
      message: "Order placed successfully",
      order: {
        id: 101,
        patientId: 7,
        patientName: "Test Patient",
        patientEmail: "patient@example.com",
        pharmacyId: 2,
        prescriptionId: null,
        pharmacyName: "Demo Pharmacy",
        status: "pending",
        subtotal: 100,
        discountTotal: 10,
        total: 90,
        currency: "LKR",
        fulfillmentType: "pickup",
        paymentMethod: "cash",
        paymentStatus: null,
        paidAt: null,
        invoice: null,
        notes: null,
        deliveryAddress: null,
        deliveryNotes: null,
        deliveryContactName: null,
        deliveryContactPhone: null,
        pharmacistNote: null,
        rejectionReason: null,
        deliveryStartedAt: null,
        deliveredAt: null,
        payment: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        items: [],
      },
    });

    const req = createMockRequest({
      body: { fulfillment_type: "pickup" },
      user: { id: 7, role: "patient" },
    });
    const res = createMockResponse();

    await checkoutController(req as any, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "order_created",
        entityType: "order",
        entityId: 101,
      })
    );
  });

  it("writes an audit log when a pharmacist changes order status", async () => {
    vi.mocked(updatePharmacyOrderStatus).mockResolvedValue({
      message: "updated",
      order: {
        id: 202,
        patientId: 8,
        patientName: "Jane Doe",
        patientEmail: "jane@example.com",
        pharmacyId: 3,
        prescriptionId: null,
        pharmacyName: "Central Pharmacy",
        status: "out_for_delivery",
        subtotal: 100,
        discountTotal: 0,
        total: 100,
        currency: "LKR",
        fulfillmentType: "delivery",
        paymentMethod: "cash",
        paymentStatus: null,
        paidAt: null,
        invoice: null,
        notes: null,
        deliveryAddress: { line1: "Main Street" },
        deliveryNotes: null,
        deliveryContactName: "Jane",
        deliveryContactPhone: "0771234567",
        pharmacistNote: null,
        rejectionReason: null,
        deliveryStartedAt: null,
        deliveredAt: null,
        payment: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        items: [],
      },
    });

    const req = createMockRequest({
      params: { id: "202" },
      body: { status: "out_for_delivery" },
      user: { id: 11, role: "pharmacist" },
    });
    const res = createMockResponse();

    await updatePharmacyOrderStatusController(req as any, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "order_status_changed",
        entityId: 202,
      })
    );
  });
});
