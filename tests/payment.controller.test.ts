import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, createMockResponse } from "./helpers/http";

vi.mock("../src/services/payment.service", () => ({
  createCheckoutSession: vi.fn(),
  getHostedCheckoutHtml: vi.fn(),
  getOrderInvoice: vi.fn(),
  getPaymentStatus: vi.fn(),
  sendInvoiceEmailForOrder: vi.fn(),
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
  getPayHereHostedCheckoutController,
  payHereNotifyController,
} from "../src/controllers/payment.controller";
import {
  createCheckoutSession,
  getHostedCheckoutHtml,
  getPaymentStatus,
  sendInvoiceEmailForOrder,
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
      hostedUrl: "https://adithyadewmini.com/api/payments/payhere/hosted/501?token=abc",
      hostedToken: "abc",
      fields: {
        merchant_id: "123",
        order_id: "88",
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

  it("returns the configured gateway error message when PayHere config is invalid", async () => {
    vi.mocked(createCheckoutSession).mockRejectedValue(
      Object.assign(new Error("Payment gateway is not configured correctly."), { statusCode: 503 })
    );

    const req = createMockRequest({
      params: { orderId: "88" },
      user: { id: 7, role: "patient" },
    });
    const res = createMockResponse();

    await createPharmacyOrderCheckoutController(req as any, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toEqual(
      expect.objectContaining({
        message: "Payment gateway is not configured correctly.",
      })
    );
  });

  it("logs PayHere hosted form fields before sending hosted checkout html", async () => {
    vi.mocked(getHostedCheckoutHtml).mockResolvedValue({
      html: "<html><body>PayHere</body></html>",
      formFields: {
        merchant_id: "1235775",
        return_url: "https://adithyadewmini.com/payment/return",
        cancel_url: "https://adithyadewmini.com/payment/cancel",
        notify_url: "https://adithyadewmini.com/api/payments/payhere/notify",
        order_id: "21",
        items: "HealthLink Pharmacy order #21",
        currency: "LKR",
        amount: "150.00",
        first_name: "Test",
        last_name: "Patient",
        email: "patient@example.com",
        phone: "0771234567",
        address: "21 Main Street",
        city: "Colombo",
        country: "Sri Lanka",
        hash: "ABCD1234EFGH5678IJKL9012MNOP3456",
      },
    } as any);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const req = createMockRequest({
      params: { paymentId: "8" },
      query: { token: "signed-token" },
    });
    const res = createMockResponse();

    await getPayHereHostedCheckoutController(req as any, res);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "PAYHERE_HOSTED_FORM_DEBUG",
        merchant_id: "1235775",
        order_id: "21",
        amount: "150.00",
        currency: "LKR",
        fieldNames: [
          "merchant_id",
          "return_url",
          "cancel_url",
          "notify_url",
          "order_id",
          "items",
          "currency",
          "amount",
          "first_name",
          "last_name",
          "email",
          "phone",
          "address",
          "city",
          "country",
          "hash",
        ],
        hashLength: 32,
        hashStart: "ABCD",
        hashEnd: "3456",
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toBe("<html><body>PayHere</body></html>");

    consoleSpy.mockRestore();
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
        gatewayOrderId: "88",
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
        order_id: "88",
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
    expect(sendInvoiceEmailForOrder).toHaveBeenCalledWith(88);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toBe("OK");
  });

  it("does not fail the notify callback when invoice email dispatch fails", async () => {
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
      invoice: null,
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
        gatewayOrderId: "88",
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
      invoice: null,
    });
    vi.mocked(sendInvoiceEmailForOrder).mockRejectedValue(new Error("SMTP timeout"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const req = createMockRequest({
      body: {
        merchant_id: "123",
        order_id: "88",
        status_code: "2",
      },
    });
    const res = createMockResponse();

    await payHereNotifyController(req as any, res);

    expect(sendInvoiceEmailForOrder).toHaveBeenCalledWith(88);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toBe("OK");

    consoleSpy.mockRestore();
  });
});
