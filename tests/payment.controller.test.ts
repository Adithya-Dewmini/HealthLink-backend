import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, createMockResponse } from "./helpers/http";

vi.mock("../src/services/payment.service", () => ({
  createCheckoutSession: vi.fn(),
  getHostedCheckoutHtml: vi.fn(),
  getOrderInvoice: vi.fn(),
  getPaymentStatus: vi.fn(),
  updatePaymentFromGatewayNotification: vi.fn(),
}));
vi.mock("../src/modules/orders/service", () => ({
  getOrderSummaryById: vi.fn(),
}));
vi.mock("../src/services/realtime.service", () => ({
  emitInvoiceGenerated: vi.fn(),
  emitOrderUpdated: vi.fn(),
  emitPaymentUpdated: vi.fn(),
}));
vi.mock("../src/services/notification.service", () => ({
  createNotificationAndPush: vi.fn(),
  getPharmacyMemberUserIds: vi.fn().mockResolvedValue([41, 42]),
}));

import {
  createPharmacyOrderCheckoutController,
  payHereNotifyController,
} from "../src/controllers/payment.controller";
import {
  createCheckoutSession,
  getPaymentStatus,
  updatePaymentFromGatewayNotification,
} from "../src/services/payment.service";
import { getOrderSummaryById } from "../src/modules/orders/service";
import {
  emitInvoiceGenerated,
  emitOrderUpdated,
  emitPaymentUpdated,
} from "../src/services/realtime.service";
import { createNotificationAndPush } from "../src/services/notification.service";

describe("payment controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a hosted checkout session for a patient pharmacy order", async () => {
    vi.mocked(createCheckoutSession).mockResolvedValue({
      orderId: 88,
      paymentId: 501,
      gateway: "payhere",
      checkoutUrl: "https://sandbox.payhere.lk/pay/checkout",
      hostedUrl: "https://demo.healthlink.app/api/payments/payhere/hosted/501?token=abc",
      hostedToken: "abc",
      fields: {
        merchant_id: "123",
        order_id: "HLPAY-88-123",
        amount: "2500.00",
        currency: "LKR",
      },
    });

    const req = createMockRequest({
      params: { orderId: "88" },
      user: { id: 7, role: "patient" },
    });
    const res = createMockResponse();

    await createPharmacyOrderCheckoutController(req as any, res);

    expect(createCheckoutSession).toHaveBeenCalledWith(88, 7);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        orderId: 88,
        paymentId: 501,
        hosted_url: expect.stringContaining("/api/payments/payhere/hosted/501"),
      })
    );
  });

  it("hides raw database errors from the checkout session response", async () => {
    vi.mocked(createCheckoutSession).mockRejectedValue(
      Object.assign(new Error("FOR UPDATE cannot be applied to the nullable side of an outer join"), {
        code: "0A000",
      })
    );

    const req = createMockRequest({
      params: { orderId: "88" },
      user: { id: 7, role: "patient" },
    });
    const res = createMockResponse();

    await createPharmacyOrderCheckoutController(req as any, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body).toEqual(
      expect.objectContaining({
        message: "Unable to complete checkout. Please try again.",
      })
    );
  });

  it("processes a successful PayHere notification and emits realtime updates", async () => {
    vi.mocked(updatePaymentFromGatewayNotification).mockResolvedValue({
      processed: true,
      orderId: 88,
      patientId: 7,
      pharmacyId: 4,
      paymentId: 501,
      paymentStatus: "paid",
      invoiceId: 91,
      invoiceNo: "HL-INV-20260515-000001",
    });
    vi.mocked(getOrderSummaryById).mockResolvedValue({
      id: 88,
      patientId: 7,
      patientName: "Test Patient",
      patientEmail: "patient@example.com",
      pharmacyId: 4,
      prescriptionId: "21",
      pharmacyName: "HealthLink Pharmacy",
      status: "confirmed",
      subtotal: 2500,
      discountTotal: 0,
      total: 2500,
      currency: "LKR",
      fulfillmentType: "pickup",
      paymentMethod: "online",
      paymentStatus: "paid",
      paidAt: new Date().toISOString(),
      invoice: {
        id: 91,
        invoiceNo: "HL-INV-20260515-000001",
        subtotal: 2500,
        deliveryFee: 0,
        serviceFee: 0,
        discount: 0,
        total: 2500,
        currency: "LKR",
        pdfUrl: null,
        issuedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      notes: null,
      deliveryAddress: null,
      deliveryNotes: null,
      deliveryContactName: null,
      deliveryContactPhone: null,
      deliveryStartedAt: null,
      deliveredAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: [],
    } as any);
    vi.mocked(getPaymentStatus).mockResolvedValue({
      orderId: 88,
      orderStatus: "confirmed",
      paymentMethod: "online",
      paymentStatus: "paid",
      paidAt: new Date().toISOString(),
      amount: 2500,
      currency: "LKR",
      gatewayPaymentId: "PH-12345",
      invoiceId: 91,
      invoiceNo: "HL-INV-20260515-000001",
      updatedAt: new Date().toISOString(),
      message: "Payment successful. Invoice HL-INV-20260515-000001 is ready.",
      payment: {
        id: 501,
        gateway: "payhere",
        gatewayPaymentId: "PH-12345",
        gatewayOrderId: "HLPAY-88-123",
        amount: 2500,
        currency: "LKR",
        status: "paid",
        method: "VISA",
        cardNoMasked: "XXXX-XXXX-XXXX-1234",
        statusMessage: "Gateway success",
        verifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      invoice: {
        id: 91,
        invoiceNo: "HL-INV-20260515-000001",
        subtotal: 2500,
        deliveryFee: 0,
        serviceFee: 0,
        discount: 0,
        total: 2500,
        currency: "LKR",
        pdfUrl: null,
        issuedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    const req = createMockRequest({
      body: {
        merchant_id: "123",
        order_id: "HLPAY-88-123",
        status_code: "2",
      },
    });
    const res = createMockResponse();

    await payHereNotifyController(req as any, res);

    expect(updatePaymentFromGatewayNotification).toHaveBeenCalled();
    expect(emitOrderUpdated).toHaveBeenCalled();
    expect(emitPaymentUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 88,
        paymentId: 501,
        status: "paid",
      })
    );
    expect(emitInvoiceGenerated).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 88,
        invoiceId: 91,
      })
    );
    expect(createNotificationAndPush).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toBe("OK");
  });
});
