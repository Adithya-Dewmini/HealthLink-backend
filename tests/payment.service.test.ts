import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { connectMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
}));

vi.mock("../src/config/db", () => ({
  default: {
    connect: connectMock,
  },
}));

vi.mock("../src/config/env", () => ({
  env: {
    appTz: "Asia/Colombo",
    jwtSecret: "test-jwt-secret",
    appWebUrl: undefined,
    publicAppUrl: undefined,
    payHereMerchantId: "1211147",
    payHereMerchantSecret: "sandbox-secret",
    payHereBaseUrl: "https://sandbox.payhere.lk/pay/checkout",
    payHereReturnUrl: "https://health-link-web.vercel.app/payment/return",
    payHereCancelUrl: "https://health-link-web.vercel.app/payment/cancel",
    payHereNotifyUrl:
      "https://healthlink-backend-5a75.onrender.com/api/payments/payhere/notify",
    paymentGatewayMode: "sandbox",
  },
}));

import {
  createCheckoutSession,
  generatePayHereHash,
  getOrderInvoice,
  updatePaymentFromGatewayNotification,
} from "../src/services/payment.service";

type QueryResult = {
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
};

const createMockClient = (handler: (sql: string, params: unknown[]) => QueryResult | Promise<QueryResult>) => {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = sql.trim().replace(/\s+/g, " ");
    if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }

    const result = await handler(normalized, params);
    return {
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? result.rows?.length ?? 0,
    };
  });

  return {
    query,
    release: vi.fn(),
  };
};

const buildNotifyMd5Sig = (input: {
  merchantId: string;
  orderId: string;
  amount: string;
  currency: string;
  statusCode: string;
  merchantSecret: string;
}) => {
  const secretMd5 = crypto.createHash("md5").update(input.merchantSecret).digest("hex").toUpperCase();
  return crypto
    .createHash("md5")
    .update(
      `${input.merchantId}${input.orderId}${input.amount}${input.currency}${input.statusCode}${secretMd5}`
    )
    .digest("hex")
    .toUpperCase();
};

const orderRow = {
  id: 88,
  patient_id: 7,
  pharmacy_id: 4,
  status: "pending_payment",
  total: 2500,
  subtotal: 2500,
  discount_total: 0,
  currency: "LKR",
  payment_method: "online",
  payment_status: "pending",
  paid_at: null,
  prescription_id: "21",
  fulfillment_type: "pickup",
  invoice_id: null,
  order_code: "HL-ORD-88",
  notes: null,
  created_at: "2026-05-16T04:00:00.000Z",
  updated_at: "2026-05-16T04:00:00.000Z",
  patient_name: "Test Patient",
  patient_email: "patient@example.com",
  patient_phone: "0771234567",
  patient_address: "21 Main Street",
  patient_city: "Colombo",
  pharmacy_name: "HealthLink Pharmacy",
  pharmacy_phone: "0110000000",
  pharmacy_email: "pharmacy@example.com",
  pharmacy_location: "Colombo",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("payment service", () => {
  it("reuses a pending checkout session for a payable pharmacy order", async () => {
    const client = createMockClient((sql) => {
      if (sql.includes("FROM orders o") && sql.includes("WHERE o.id = $1") && sql.includes("FOR UPDATE")) {
        return { rows: [orderRow] };
      }

      if (
        sql.includes("SELECT id, gateway_order_id, amount, currency FROM payments") &&
        sql.includes("status = 'pending'")
      ) {
        return {
          rows: [
            {
              id: 501,
              gateway_order_id: "HLPAY-88-1715820000000",
              amount: 2500,
              currency: "LKR",
            },
          ],
        };
      }

      if (sql.startsWith("UPDATE payments SET amount = $2")) {
        return { rows: [] };
      }

      if (sql.startsWith("UPDATE orders SET status = 'pending_payment'")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    connectMock.mockResolvedValue(client);

    const session = await createCheckoutSession(88, 7);

    expect(session.paymentId).toBe(501);
    expect(session.hostedUrl).toContain(
      "https://healthlink-backend-5a75.onrender.com/api/payments/payhere/hosted/501"
    );
    expect(session.fields.amount).toBe("2500.00");
    expect(session.fields.currency).toBe("LKR");
    expect(session.fields.hash).toBe(
      generatePayHereHash(
        "1211147",
        "HLPAY-88-1715820000000",
        "2500.00",
        "LKR",
        "sandbox-secret"
      )
    );
    expect(
      client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO payments"))
    ).toBe(false);
  });

  it("marks a payment as paid and creates a single invoice for a valid notify callback", async () => {
    let invoiceInserted = 0;

    const client = createMockClient((sql) => {
      if (sql.includes("FROM payments p JOIN orders o") && sql.includes("WHERE p.gateway_order_id = $1")) {
        return {
          rows: [
            {
              id: 501,
              order_id: 88,
              patient_id: 7,
              pharmacy_id: 4,
              status: "pending",
              amount: 2500,
              currency: "LKR",
              order_status: "pending_payment",
              order_total: 2500,
              order_currency: "LKR",
            },
          ],
        };
      }

      if (sql.startsWith("UPDATE payments SET gateway_payment_id")) {
        return { rows: [] };
      }

      if (sql.includes("SELECT COUNT(*) FILTER") && sql.includes("FROM order_items")) {
        return { rows: [{ partial_items: 0 }] };
      }

      if (sql.startsWith("UPDATE orders SET payment_method = 'online'")) {
        return { rows: [] };
      }

      if (sql.includes("SELECT * FROM invoices") && sql.includes("WHERE order_id = $1")) {
        return { rows: [] };
      }

      if (sql.includes("FROM orders o") && sql.includes("WHERE o.id = $1") && sql.includes("FOR UPDATE")) {
        return { rows: [orderRow] };
      }

      if (sql.includes("SELECT * FROM payments") && sql.includes("WHERE order_id = $1")) {
        return {
          rows: [
            {
              id: 501,
              gateway: "payhere",
              gateway_order_id: "HLPAY-88-1715820000000",
              gateway_payment_id: "PH-12345",
              amount: 2500,
              currency: "LKR",
              status: "paid",
            },
          ],
        };
      }

      if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
        return { rows: [] };
      }

      if (sql.includes("SELECT COUNT(*)::int AS invoice_count FROM invoices")) {
        return { rows: [{ invoice_count: 0 }] };
      }

      if (sql.startsWith("INSERT INTO invoices")) {
        invoiceInserted += 1;
        return {
          rows: [
            {
              id: 91,
              invoice_no: "HL-INV-20260516-000001",
              subtotal: 2500,
              delivery_fee: 0,
              service_fee: 0,
              discount: 0,
              total: 2500,
              currency: "LKR",
              pdf_url: null,
              issued_at: "2026-05-16T04:10:00.000Z",
              created_at: "2026-05-16T04:10:00.000Z",
              updated_at: "2026-05-16T04:10:00.000Z",
            },
          ],
        };
      }

      if (sql.startsWith("UPDATE orders SET invoice_id = $2")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    connectMock.mockResolvedValue(client);

    const payload = {
      merchant_id: "1211147",
      order_id: "HLPAY-88-1715820000000",
      payment_id: "PH-12345",
      payhere_amount: "2500.00",
      payhere_currency: "LKR",
      status_code: "2",
      md5sig: buildNotifyMd5Sig({
        merchantId: "1211147",
        orderId: "HLPAY-88-1715820000000",
        amount: "2500.00",
        currency: "LKR",
        statusCode: "2",
        merchantSecret: "sandbox-secret",
      }),
      method: "VISA",
      card_no: "XXXX-XXXX-XXXX-1234",
      status_message: "Payment successful",
      custom_1: "88",
      custom_2: "501",
    };

    const result = await updatePaymentFromGatewayNotification(payload);

    expect(result).toEqual(
      expect.objectContaining({
        processed: true,
        orderId: 88,
        paymentId: 501,
        paymentStatus: "paid",
        invoiceId: 91,
        invoiceNo: "HL-INV-20260516-000001",
      })
    );
    expect(invoiceInserted).toBe(1);
  });

  it("ignores invalid md5 signatures without marking the order as paid", async () => {
    const client = createMockClient(() => {
      throw new Error("No SQL should run for an invalid checksum");
    });

    connectMock.mockResolvedValue(client);

    const result = await updatePaymentFromGatewayNotification({
      merchant_id: "1211147",
      order_id: "HLPAY-88-1715820000000",
      payhere_amount: "2500.00",
      payhere_currency: "LKR",
      status_code: "2",
      md5sig: "INVALID",
    });

    expect(result).toEqual(
      expect.objectContaining({
        processed: false,
        ignoredReason: "Invalid notification checksum",
      })
    );
  });

  it("ignores amount mismatches from gateway callbacks", async () => {
    const client = createMockClient((sql) => {
      if (sql.includes("FROM payments p JOIN orders o") && sql.includes("WHERE p.gateway_order_id = $1")) {
        return {
          rows: [
            {
              id: 501,
              order_id: 88,
              patient_id: 7,
              pharmacy_id: 4,
              status: "pending",
              amount: 2600,
              currency: "LKR",
              order_status: "pending_payment",
              order_total: 2600,
              order_currency: "LKR",
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    connectMock.mockResolvedValue(client);

    const result = await updatePaymentFromGatewayNotification({
      merchant_id: "1211147",
      order_id: "HLPAY-88-1715820000000",
      payhere_amount: "2500.00",
      payhere_currency: "LKR",
      status_code: "2",
      md5sig: buildNotifyMd5Sig({
        merchantId: "1211147",
        orderId: "HLPAY-88-1715820000000",
        amount: "2500.00",
        currency: "LKR",
        statusCode: "2",
        merchantSecret: "sandbox-secret",
      }),
    });

    expect(result).toEqual(
      expect.objectContaining({
        processed: false,
        ignoredReason: "Amount mismatch",
      })
    );
  });

  it("does not create a duplicate invoice for duplicate successful notifications", async () => {
    let invoiceInsertAttempts = 0;

    const client = createMockClient((sql) => {
      if (sql.includes("FROM payments p JOIN orders o") && sql.includes("WHERE p.gateway_order_id = $1")) {
        return {
          rows: [
            {
              id: 501,
              order_id: 88,
              patient_id: 7,
              pharmacy_id: 4,
              status: "paid",
              amount: 2500,
              currency: "LKR",
              order_status: "confirmed",
              order_total: 2500,
              order_currency: "LKR",
            },
          ],
        };
      }

      if (sql.includes("SELECT * FROM invoices") && sql.includes("WHERE order_id = $1")) {
        return {
          rows: [
            {
              id: 91,
              invoice_no: "HL-INV-20260516-000001",
              subtotal: 2500,
              delivery_fee: 0,
              service_fee: 0,
              discount: 0,
              total: 2500,
              currency: "LKR",
              pdf_url: null,
              issued_at: "2026-05-16T04:10:00.000Z",
              created_at: "2026-05-16T04:10:00.000Z",
              updated_at: "2026-05-16T04:10:00.000Z",
            },
          ],
        };
      }

      if (sql.startsWith("INSERT INTO invoices")) {
        invoiceInsertAttempts += 1;
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    connectMock.mockResolvedValue(client);

    const result = await updatePaymentFromGatewayNotification({
      merchant_id: "1211147",
      order_id: "HLPAY-88-1715820000000",
      payhere_amount: "2500.00",
      payhere_currency: "LKR",
      status_code: "2",
      md5sig: buildNotifyMd5Sig({
        merchantId: "1211147",
        orderId: "HLPAY-88-1715820000000",
        amount: "2500.00",
        currency: "LKR",
        statusCode: "2",
        merchantSecret: "sandbox-secret",
      }),
    });

    expect(result).toEqual(
      expect.objectContaining({
        processed: true,
        paymentStatus: "paid",
        invoiceId: 91,
        invoiceNo: "HL-INV-20260516-000001",
      })
    );
    expect(invoiceInsertAttempts).toBe(0);
  });

  it("updates payment state for cancelled notifications without generating an invoice", async () => {
    let invoiceInsertAttempts = 0;

    const client = createMockClient((sql) => {
      if (sql.includes("FROM payments p JOIN orders o") && sql.includes("WHERE p.gateway_order_id = $1")) {
        return {
          rows: [
            {
              id: 501,
              order_id: 88,
              patient_id: 7,
              pharmacy_id: 4,
              status: "pending",
              amount: 2500,
              currency: "LKR",
              order_status: "pending_payment",
              order_total: 2500,
              order_currency: "LKR",
            },
          ],
        };
      }

      if (sql.startsWith("UPDATE payments SET gateway_payment_id")) {
        return { rows: [] };
      }

      if (sql.startsWith("UPDATE orders SET payment_method = COALESCE")) {
        return { rows: [] };
      }

      if (sql.startsWith("INSERT INTO invoices")) {
        invoiceInsertAttempts += 1;
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    connectMock.mockResolvedValue(client);

    const result = await updatePaymentFromGatewayNotification({
      merchant_id: "1211147",
      order_id: "HLPAY-88-1715820000000",
      payhere_amount: "2500.00",
      payhere_currency: "LKR",
      status_code: "-1",
      md5sig: buildNotifyMd5Sig({
        merchantId: "1211147",
        orderId: "HLPAY-88-1715820000000",
        amount: "2500.00",
        currency: "LKR",
        statusCode: "-1",
        merchantSecret: "sandbox-secret",
      }),
      status_message: "Payment cancelled by user",
    });

    expect(result).toEqual(
      expect.objectContaining({
        processed: true,
        paymentStatus: "cancelled",
      })
    );
    expect(invoiceInsertAttempts).toBe(0);
  });

  it("rejects invoice access when the patient does not own the order", async () => {
    const client = createMockClient((sql) => {
      if (sql.includes("FROM orders o") && sql.includes("WHERE o.id = $1") && sql.includes("FOR UPDATE")) {
        return { rows: [orderRow] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    connectMock.mockResolvedValue(client);

    await expect(getOrderInvoice(88, { userId: 999, role: "patient" })).rejects.toThrow(
      "You do not have access to this invoice"
    );
  });
});
