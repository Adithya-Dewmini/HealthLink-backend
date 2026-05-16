import { beforeEach, describe, expect, it, vi } from "vitest";

const { connectMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
}));

vi.mock("../src/config/db", () => ({
  default: {
    connect: connectMock,
  },
}));

vi.mock("../src/modules/pharmacy/schema", () => ({
  getInventorySchema: vi.fn().mockResolvedValue({
    pharmacyCol: "pharmacy_id",
    medicineCol: "medicine_id",
    stockCol: "stock_quantity",
    priceCol: "unit_price",
    reservedCol: "reserved_quantity",
  }),
  quoteIdent: (value: string) => `"${value}"`,
}));

vi.mock("../src/modules/pharmacy/service", () => ({
  fetchPharmacyProfileByUserId: vi.fn(),
}));

import { checkoutCart } from "../src/modules/orders/service";

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

const createdOrderRow = {
  id: 301,
  patient_id: 7,
  pharmacy_id: 4,
  prescription_id: null,
  status: "pending",
  subtotal: 2000,
  discount_total: 200,
  total: 1800,
  currency: "LKR",
  fulfillment_type: "pickup",
  payment_method: "cash",
  payment_status: null,
  paid_at: null,
  notes: null,
  pharmacist_note: null,
  rejection_reason: null,
  delivery_address: null,
  delivery_notes: null,
  delivery_contact_name: null,
  delivery_contact_phone: null,
  delivery_started_at: null,
  delivered_at: null,
  created_at: "2026-05-16T06:00:00.000Z",
  updated_at: "2026-05-16T06:00:00.000Z",
  pharmacy_name: "Demo Pharmacy",
  patient_name: "Test Patient",
  patient_email: "patient@example.com",
  invoice_id: null,
};

const orderItemRows = [
  {
    order_item_id: 1,
    marketplace_product_id: 11,
    inventory_item_id: 901,
    prescription_item_id: null,
    substituted_inventory_item_id: null,
    substitution_approved: false,
    quantity: 2,
    requested_quantity: 2,
    approved_quantity: 2,
    unit_price: 900,
    total_price: 1800,
    item_status: "pending",
    substitution_name: null,
    note: null,
    name: "Paracetamol",
    image_url: null,
    requires_prescription: false,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkoutCart", () => {
  it("completes a cash checkout with matching order and order-item insert placeholders", async () => {
    const client = createMockClient((sql, params) => {
      if (sql.includes("FROM carts") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: 21, patient_id: 7, pharmacy_id: 4 }] };
      }

      if (sql.includes("FROM cart_items") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{ id: 41, marketplace_product_id: 11, quantity: 2 }],
        };
      }

      if (sql.includes("FROM marketplace_products mp") && sql.includes("FOR UPDATE OF inv")) {
        return {
          rows: [
            {
              marketplace_product_id: 11,
              pharmacy_id: 4,
              inventory_item_id: 901,
              name: "Paracetamol",
              price: 1000,
              discount_price: 900,
              requires_prescription: false,
              is_active: true,
              verification_status: "approved",
              pharmacy_status: "active",
              stock_quantity: 10,
              reserved_quantity: 0,
              available_stock: 10,
            },
          ],
        };
      }

      if (sql.startsWith("INSERT INTO orders")) {
        expect(params).toHaveLength(14);
        expect(sql).toContain("delivery_contact_phone");
        return { rows: [{ id: 301 }] };
      }

      if (sql.startsWith("INSERT INTO order_items")) {
        expect(params).toHaveLength(6);
        return { rows: [] };
      }

      if (sql.startsWith('UPDATE inventory SET "reserved_quantity"')) {
        return { rows: [] };
      }

      if (sql.startsWith("DELETE FROM cart_items")) {
        return { rows: [] };
      }

      if (sql.startsWith("UPDATE carts SET pharmacy_id = NULL")) {
        return { rows: [] };
      }

      if (sql.includes("FROM orders o") && sql.includes("WHERE o.id = $1 AND o.patient_id = $2")) {
        return { rows: [createdOrderRow] };
      }

      if (sql.includes("SELECT * FROM payments") && sql.includes("WHERE order_id = $1")) {
        return { rows: [] };
      }

      if (sql.includes("SELECT * FROM invoices") && sql.includes("WHERE order_id = $1")) {
        return { rows: [] };
      }

      if (sql.includes("FROM order_items oi") && sql.includes("JOIN marketplace_products mp")) {
        return { rows: orderItemRows };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    connectMock.mockResolvedValue(client);

    const result = await checkoutCart(7, {
      fulfillmentType: "pickup",
      paymentMethod: "cash",
      notes: null,
      deliveryAddress: null,
      deliveryNotes: null,
      deliveryContactName: null,
      deliveryContactPhone: null,
    });

    expect(result.order.id).toBe(301);
    expect(result.order.status).toBe("pending");
    expect(result.order.paymentMethod).toBe("cash");
    expect(result.order.paymentStatus).toBeNull();
    expect(result.order.items).toHaveLength(1);
  });

  it("completes an online checkout and leaves the order pending payment", async () => {
    const client = createMockClient((sql, params) => {
      if (sql.includes("FROM carts") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: 21, patient_id: 7, pharmacy_id: 4 }] };
      }

      if (sql.includes("FROM cart_items") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{ id: 41, marketplace_product_id: 11, quantity: 2 }],
        };
      }

      if (sql.includes("FROM marketplace_products mp") && sql.includes("FOR UPDATE OF inv")) {
        return {
          rows: [
            {
              marketplace_product_id: 11,
              pharmacy_id: 4,
              inventory_item_id: 901,
              name: "Paracetamol",
              price: 1000,
              discount_price: 900,
              requires_prescription: false,
              is_active: true,
              verification_status: "approved",
              pharmacy_status: "active",
              stock_quantity: 10,
              reserved_quantity: 0,
              available_stock: 10,
            },
          ],
        };
      }

      if (sql.startsWith("INSERT INTO orders")) {
        expect(params[2]).toBe("pending_payment");
        expect(params[8]).toBe("pending");
        return { rows: [{ id: 302 }] };
      }

      if (sql.startsWith("INSERT INTO order_items")) {
        expect(params).toHaveLength(6);
        return { rows: [] };
      }

      if (sql.startsWith('UPDATE inventory SET "reserved_quantity"')) {
        return { rows: [] };
      }

      if (sql.startsWith("DELETE FROM cart_items")) {
        return { rows: [] };
      }

      if (sql.startsWith("UPDATE carts SET pharmacy_id = NULL")) {
        return { rows: [] };
      }

      if (sql.includes("FROM orders o") && sql.includes("WHERE o.id = $1 AND o.patient_id = $2")) {
        return {
          rows: [
            {
              ...createdOrderRow,
              id: 302,
              status: "pending_payment",
              payment_method: "online",
              payment_status: "pending",
            },
          ],
        };
      }

      if (sql.includes("SELECT * FROM payments") && sql.includes("WHERE order_id = $1")) {
        return { rows: [] };
      }

      if (sql.includes("SELECT * FROM invoices") && sql.includes("WHERE order_id = $1")) {
        return { rows: [] };
      }

      if (sql.includes("FROM order_items oi") && sql.includes("JOIN marketplace_products mp")) {
        return { rows: orderItemRows };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    connectMock.mockResolvedValue(client);

    const result = await checkoutCart(7, {
      fulfillmentType: "pickup",
      paymentMethod: "online",
      notes: null,
      deliveryAddress: null,
      deliveryNotes: null,
      deliveryContactName: null,
      deliveryContactPhone: null,
    });

    expect(result.order.id).toBe(302);
    expect(result.order.status).toBe("pending_payment");
    expect(result.order.paymentMethod).toBe("online");
    expect(result.order.paymentStatus).toBe("pending");
  });

  it("fails when stock is no longer available", async () => {
    const client = createMockClient((sql) => {
      if (sql.includes("FROM carts") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: 21, patient_id: 7, pharmacy_id: 4 }] };
      }

      if (sql.includes("FROM cart_items") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{ id: 41, marketplace_product_id: 11, quantity: 2 }],
        };
      }

      if (sql.includes("FROM marketplace_products mp") && sql.includes("FOR UPDATE OF inv")) {
        return {
          rows: [
            {
              marketplace_product_id: 11,
              pharmacy_id: 4,
              inventory_item_id: 901,
              name: "Paracetamol",
              price: 1000,
              discount_price: 900,
              requires_prescription: false,
              is_active: true,
              verification_status: "approved",
              pharmacy_status: "active",
              stock_quantity: 1,
              reserved_quantity: 0,
              available_stock: 1,
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });

    connectMock.mockResolvedValue(client);

    await expect(
      checkoutCart(7, {
        fulfillmentType: "pickup",
        paymentMethod: "cash",
        notes: null,
        deliveryAddress: null,
        deliveryNotes: null,
        deliveryContactName: null,
        deliveryContactPhone: null,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Insufficient stock for "Paracetamol"',
    });
  });
});
