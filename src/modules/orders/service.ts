import pool from "../../config/db";
import type { PoolClient } from "pg";
import { HttpError } from "../pharmacy/errors";
import { fetchPharmacyProfileByUserId } from "../pharmacy/service";
import { getInventorySchema, quoteIdent } from "../pharmacy/schema";
import type {
  CheckoutInput,
  DeliveryAddress,
  FulfillmentType,
  InvoiceSummary,
  OrderItemSummary,
  PaymentSummary,
  OrderStatus,
  OrderSummary,
  PaymentMethod,
  RejectOrderInput,
  ReviewOrderInput,
  UpdateOrderStatusInput,
} from "./types";
import { assertOrderReadyForPharmacyProcessing } from "./paymentGuard";

type DbRecord = Record<string, any>;
type CheckoutProductRow = {
  marketplace_product_id: number | string;
  pharmacy_id: number | string;
  inventory_item_id: number | string;
  name: string;
  price: number | string | null;
  discount_price: number | string | null;
  requires_prescription: boolean;
  is_active: boolean;
  verification_status: string;
  pharmacy_status: string;
  stock_quantity: number | string | null;
  reserved_quantity: number | string | null;
  available_stock: number | string | null;
};
type OrderMutationItemRow = {
  id: number | string;
  inventory_item_id: number | string;
  quantity: number | string | null;
};
type LockedOrderItemRow = {
  id: number | string;
  inventory_item_id: number | string;
  requested_quantity: number | string | null;
  approved_quantity: number | string | null;
  quantity: number | string | null;
  unit_price: number | string | null;
};
type InventoryAvailabilityRow = {
  stock_quantity: number | string | null;
  reserved_quantity: number | string | null;
};

const normalizeMoney = (value: unknown) => Number(Number(value ?? 0).toFixed(2));

const normalizeDeliveryAddress = (value: unknown): DeliveryAddress | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const line1 = typeof source.line1 === "string" ? source.line1.trim() : "";
  if (!line1) {
    return null;
  }

  return {
    line1,
    line2: typeof source.line2 === "string" && source.line2.trim() ? source.line2.trim() : null,
    city: typeof source.city === "string" && source.city.trim() ? source.city.trim() : null,
    district:
      typeof source.district === "string" && source.district.trim() ? source.district.trim() : null,
    postalCode:
      typeof source.postalCode === "string" && source.postalCode.trim()
        ? source.postalCode.trim()
        : typeof source.postal_code === "string" && source.postal_code.trim()
          ? source.postal_code.trim()
          : null,
    landmark:
      typeof source.landmark === "string" && source.landmark.trim() ? source.landmark.trim() : null,
  };
};

const ORDER_TRANSITIONS: Record<FulfillmentType | "default", Record<OrderStatus, OrderStatus[]>> = {
  pickup: {
    pending_payment: [],
    pending: ["confirmed", "awaiting_substitution_approval", "partially_ready", "cancelled"],
    confirmed: ["preparing", "awaiting_substitution_approval", "partially_ready", "cancelled"],
    preparing: ["ready_for_pickup", "awaiting_substitution_approval", "partially_ready", "cancelled"],
    awaiting_substitution_approval: ["confirmed", "preparing", "partially_ready", "cancelled"],
    partially_ready: ["ready_for_pickup", "awaiting_substitution_approval", "completed", "cancelled"],
    ready_for_pickup: ["completed", "cancelled"],
    out_for_delivery: [],
    delivered: [],
    completed: [],
    cancelled: [],
    rejected: [],
  },
  delivery: {
    pending_payment: [],
    pending: ["confirmed", "awaiting_substitution_approval", "partially_ready", "cancelled"],
    confirmed: ["preparing", "awaiting_substitution_approval", "partially_ready", "cancelled"],
    preparing: ["out_for_delivery", "awaiting_substitution_approval", "partially_ready", "cancelled"],
    awaiting_substitution_approval: ["confirmed", "preparing", "partially_ready", "cancelled"],
    partially_ready: ["out_for_delivery", "awaiting_substitution_approval", "cancelled"],
    ready_for_pickup: [],
    out_for_delivery: ["delivered", "cancelled"],
    delivered: [],
    completed: [],
    cancelled: [],
    rejected: [],
  },
  default: {
    pending_payment: [],
    pending: ["confirmed", "awaiting_substitution_approval", "partially_ready", "cancelled"],
    confirmed: ["preparing", "awaiting_substitution_approval", "partially_ready", "cancelled"],
    preparing: ["ready_for_pickup", "awaiting_substitution_approval", "partially_ready", "cancelled"],
    awaiting_substitution_approval: ["confirmed", "preparing", "partially_ready", "cancelled"],
    partially_ready: ["ready_for_pickup", "awaiting_substitution_approval", "completed", "cancelled"],
    ready_for_pickup: ["completed", "cancelled"],
    out_for_delivery: [],
    delivered: [],
    completed: [],
    cancelled: [],
    rejected: [],
  },
};

const getOrderTransitions = (fulfillmentType: string | null | undefined) => {
  if (fulfillmentType === "delivery") return ORDER_TRANSITIONS.delivery;
  if (fulfillmentType === "pickup") return ORDER_TRANSITIONS.pickup;
  return ORDER_TRANSITIONS.default;
};

const withTransaction = async <T>(callback: (client: PoolClient) => Promise<T>) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const getReservedExpr = (reservedCol: string | null) =>
  reservedCol ? `COALESCE(inv.${quoteIdent(reservedCol)}, 0)` : "0";

const normalizeOrderItem = (row: DbRecord): OrderItemSummary => ({
  id: Number(row.order_item_id),
  marketplaceProductId: Number(row.marketplace_product_id),
  inventoryItemId: Number(row.inventory_item_id),
  substitutedInventoryItemId:
    row.substituted_inventory_item_id === null || row.substituted_inventory_item_id === undefined
      ? null
      : Number(row.substituted_inventory_item_id),
  substitutionApproved: Boolean(row.substitution_approved),
  name: row.name,
  quantity: Number(row.quantity ?? 0),
  requestedQuantity: Number(row.requested_quantity ?? row.quantity ?? 0),
  approvedQuantity: Number(row.approved_quantity ?? row.quantity ?? 0),
  unitPrice: normalizeMoney(row.unit_price),
  totalPrice: normalizeMoney(row.total_price),
  status: row.item_status,
  prescriptionItemId:
    row.prescription_item_id === null || row.prescription_item_id === undefined
      ? null
      : String(row.prescription_item_id),
  substitutionName: row.substitution_name ?? null,
  note: row.note ?? null,
  imageUrl: row.image_url ?? null,
  requiresPrescription: Boolean(row.requires_prescription),
});

const loadOrderItems = async (client: PoolClient, orderId: number) => {
  const result = await client.query<CheckoutProductRow>(
    `
      SELECT
        oi.id AS order_item_id,
        oi.marketplace_product_id,
        oi.inventory_item_id,
        oi.prescription_item_id,
        oi.substituted_inventory_item_id,
        oi.substitution_approved,
        oi.quantity,
        oi.requested_quantity,
        oi.approved_quantity,
        oi.unit_price,
        oi.total_price,
        oi.status AS item_status,
        oi.substitution_name,
        oi.note,
        mp.name,
        mp.image_url,
        mp.requires_prescription
      FROM order_items oi
      JOIN marketplace_products mp ON mp.id = oi.marketplace_product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id ASC
    `,
    [orderId]
  );

  return result.rows.map(normalizeOrderItem);
};

const normalizePayment = (row: DbRecord | undefined | null): PaymentSummary | null => {
  if (!row?.id) return null;
  return {
    id: Number(row.id),
    gateway: "payhere",
    gatewayPaymentId: row.gateway_payment_id ?? null,
    gatewayOrderId: row.gateway_order_id ?? null,
    amount: normalizeMoney(row.amount),
    currency: row.currency ?? "LKR",
    status: row.status,
    method: row.method ?? null,
    cardNoMasked: row.card_no_masked ?? null,
    statusMessage: row.status_message ?? null,
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
};

const normalizeInvoice = (row: DbRecord | undefined | null): InvoiceSummary | null => {
  if (!row?.id) return null;
  return {
    id: Number(row.id),
    invoiceNo: row.invoice_no,
    subtotal: normalizeMoney(row.subtotal),
    deliveryFee: normalizeMoney(row.delivery_fee),
    serviceFee: normalizeMoney(row.service_fee),
    discount: normalizeMoney(row.discount),
    total: normalizeMoney(row.total),
    currency: row.currency ?? "LKR",
    pdfUrl: row.pdf_url ?? null,
    issuedAt: new Date(row.issued_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
};

const loadOrderPayment = async (client: PoolClient, orderId: number) => {
  const result = await client.query(
    `
      SELECT *
      FROM payments
      WHERE order_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [orderId]
  );
  return normalizePayment(result.rows[0]);
};

const loadOrderInvoice = async (client: PoolClient, orderId: number, invoiceId?: unknown) => {
  const result = await client.query(
    `
      SELECT *
      FROM invoices
      WHERE order_id = $1
         OR ($2::bigint IS NOT NULL AND id = $2::bigint)
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [orderId, invoiceId ? Number(invoiceId) : null]
  );
  return normalizeInvoice(result.rows[0]);
};

const buildOrderSummary = async (client: PoolClient, orderRow: DbRecord): Promise<OrderSummary> => {
  const payment = await loadOrderPayment(client, Number(orderRow.id));
  const invoice = await loadOrderInvoice(client, Number(orderRow.id), orderRow.invoice_id);

  return {
    id: Number(orderRow.id),
    patientId: Number(orderRow.patient_id),
    patientName: typeof orderRow.patient_name === "string" ? orderRow.patient_name : null,
    patientEmail: typeof orderRow.patient_email === "string" ? orderRow.patient_email : null,
    pharmacyId: Number(orderRow.pharmacy_id),
    prescriptionId:
      orderRow.prescription_id === null || orderRow.prescription_id === undefined
        ? null
        : String(orderRow.prescription_id),
    pharmacyName: orderRow.pharmacy_name,
    status: orderRow.status,
    subtotal: normalizeMoney(orderRow.subtotal),
    discountTotal: normalizeMoney(orderRow.discount_total),
    total: normalizeMoney(orderRow.total),
    currency: orderRow.currency ?? "LKR",
    fulfillmentType: orderRow.fulfillment_type === "delivery" ? "delivery" : "pickup",
    paymentMethod: (orderRow.payment_method ?? null) as PaymentMethod | null,
    paymentStatus: orderRow.payment_status ?? payment?.status ?? null,
    paidAt: orderRow.paid_at ? new Date(orderRow.paid_at).toISOString() : null,
    notes: orderRow.notes ?? null,
    pharmacistNote: orderRow.pharmacist_note ?? null,
    rejectionReason: orderRow.rejection_reason ?? null,
    deliveryAddress: normalizeDeliveryAddress(orderRow.delivery_address),
    deliveryNotes: orderRow.delivery_notes ?? null,
    deliveryContactName: orderRow.delivery_contact_name ?? null,
    deliveryContactPhone: orderRow.delivery_contact_phone ?? null,
    deliveryStartedAt: orderRow.delivery_started_at ? new Date(orderRow.delivery_started_at).toISOString() : null,
    deliveredAt: orderRow.delivered_at ? new Date(orderRow.delivered_at).toISOString() : null,
    createdAt: new Date(orderRow.created_at).toISOString(),
    updatedAt: new Date(orderRow.updated_at).toISOString(),
    payment,
    invoice,
    items: await loadOrderItems(client, Number(orderRow.id)),
  };
};

const getOrderBaseQuery = () => `
  SELECT
    o.*,
    p.name AS pharmacy_name,
    u.name AS patient_name,
    u.email AS patient_email
  FROM orders o
  JOIN pharmacies p ON p.id = o.pharmacy_id
  LEFT JOIN users u ON u.id = o.patient_id
`;

const TERMINAL_ORDER_STATUSES = new Set(["completed", "delivered", "cancelled", "rejected"]);

const getPrescriptionStatusFromOrderStatus = (status: OrderStatus) => {
  if (status === "completed" || status === "delivered") return "fulfilled";
  if (status === "partially_ready") return "partially_fulfilled";
  if (status === "cancelled" || status === "rejected") return "issued";
  return "sent_to_pharmacy";
};

const getPatientOrder = async (client: PoolClient, orderId: number, patientId: number) => {
  const result = await client.query(
    `
      ${getOrderBaseQuery()}
      WHERE o.id = $1 AND o.patient_id = $2
      LIMIT 1
    `,
    [orderId, patientId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, "Order not found");
  }

  return buildOrderSummary(client, row);
};

const getPharmacyOrder = async (client: PoolClient, orderId: number, pharmacyId: number) => {
  const result = await client.query(
    `
      ${getOrderBaseQuery()}
      WHERE o.id = $1 AND o.pharmacy_id = $2
      LIMIT 1
    `,
    [orderId, pharmacyId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, "Order not found");
  }

  return { row, summary: await buildOrderSummary(client, row) };
};

export const getOrderSummaryById = async (orderId: number) =>
  withTransaction(async (client) => {
    const result = await client.query(
      `
        ${getOrderBaseQuery()}
        WHERE o.id = $1
        LIMIT 1
      `,
      [orderId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new HttpError(404, "Order not found");
    }
    return buildOrderSummary(client, row);
  });

const loadLockedCart = async (client: PoolClient, patientId: number) => {
  const cartResult = await client.query(
    `
      SELECT id, patient_id, pharmacy_id
      FROM carts
      WHERE patient_id = $1
      LIMIT 1
      FOR UPDATE
    `,
    [patientId]
  );

  const cart = cartResult.rows[0];
  if (!cart) {
    throw new HttpError(404, "Cart not found");
  }

  const items = await client.query(
    `
      SELECT id, marketplace_product_id, quantity
      FROM cart_items
      WHERE cart_id = $1
      ORDER BY id ASC
      FOR UPDATE
    `,
    [cart.id]
  );

  return { cart, items: items.rows };
};

const loadCheckoutProducts = async (
  client: PoolClient,
  pharmacyId: number,
  marketplaceProductIds: number[]
) => {
  const inventory = await getInventorySchema(client);
  const reservedExpr = getReservedExpr(inventory.reservedCol);
  const result = await client.query(
    `
      SELECT
        mp.id AS marketplace_product_id,
        mp.pharmacy_id,
        mp.inventory_item_id,
        mp.name,
        mp.price,
        mp.discount_price,
        mp.requires_prescription,
        mp.is_active,
        LOWER(COALESCE(p.verification_status, 'pending')) AS verification_status,
        LOWER(COALESCE(p.status, 'active')) AS pharmacy_status,
        COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0)::int AS stock_quantity,
        ${reservedExpr}::int AS reserved_quantity,
        GREATEST(COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0) - ${reservedExpr}, 0)::int AS available_stock
      FROM marketplace_products mp
      JOIN pharmacies p ON p.id = mp.pharmacy_id
      JOIN inventory inv
        ON inv.${quoteIdent(inventory.pharmacyCol)} = mp.pharmacy_id
       AND inv.${quoteIdent(inventory.medicineCol)} = mp.inventory_item_id
      WHERE mp.pharmacy_id = $1
        AND mp.id = ANY($2::int[])
      FOR UPDATE OF inv
    `,
    [pharmacyId, marketplaceProductIds]
  );

  return new Map<number, CheckoutProductRow>(
    result.rows.map((row) => [Number(row.marketplace_product_id), row])
  );
};

const assertCheckoutProduct = (product: DbRecord | undefined, quantity: number) => {
  if (!product) {
    throw new HttpError(404, "Marketplace product not found in this pharmacy");
  }

  if (!product.is_active) {
    throw new HttpError(409, `Product "${product.name}" is no longer active`);
  }

  if (product.verification_status !== "approved") {
    throw new HttpError(409, "This pharmacy storefront is not available");
  }

  if (["inactive", "disabled", "closed", "suspended"].includes(String(product.pharmacy_status))) {
    throw new HttpError(409, "This pharmacy is not currently accepting orders");
  }

  if (product.requires_prescription) {
    throw new HttpError(
      409,
      `Prescription-required product "${product.name}" cannot be checked out in this flow yet`
    );
  }

  if (Number(product.available_stock ?? 0) < quantity) {
    throw new HttpError(409, `Insufficient stock for "${product.name}"`);
  }
};

const applyInventoryFinalization = async (
  client: PoolClient,
  pharmacyId: number,
  items: Array<{ inventoryItemId: number; quantity: number }>,
  mode: "complete" | "cancel"
) => {
  if (!items.length) return;

  const inventory = await getInventorySchema(client);
  if (!inventory.reservedCol) {
    throw new HttpError(500, "Inventory reservation column is not available");
  }

  for (const item of items) {
    const row = await client.query(
      `
        SELECT
          ${quoteIdent(inventory.stockCol)} AS stock_quantity,
          ${quoteIdent(inventory.reservedCol)} AS reserved_quantity
        FROM inventory
        WHERE ${quoteIdent(inventory.pharmacyCol)} = $1
          AND ${quoteIdent(inventory.medicineCol)} = $2
        LIMIT 1
        FOR UPDATE
      `,
      [pharmacyId, item.inventoryItemId]
    );

    if (!row.rows.length) {
      throw new HttpError(404, "Inventory item not found during order finalization");
    }

    const stockQuantity = Number(row.rows[0].stock_quantity ?? 0);
    const reservedQuantity = Number(row.rows[0].reserved_quantity ?? 0);

    if (reservedQuantity < item.quantity) {
      throw new HttpError(409, "Reserved inventory is lower than the order quantity");
    }

    if (mode === "complete" && stockQuantity < item.quantity) {
      throw new HttpError(409, "Inventory stock is lower than the order quantity");
    }

    await client.query(
      `
        UPDATE inventory
        SET
          ${quoteIdent(inventory.stockCol)} = ${
            mode === "complete"
              ? `GREATEST(COALESCE(${quoteIdent(inventory.stockCol)}, 0) - $3, 0)`
              : quoteIdent(inventory.stockCol)
          },
          ${quoteIdent(inventory.reservedCol)} = GREATEST(COALESCE(${quoteIdent(
            inventory.reservedCol
          )}, 0) - $3, 0)
        WHERE ${quoteIdent(inventory.pharmacyCol)} = $1
          AND ${quoteIdent(inventory.medicineCol)} = $2
      `,
      [pharmacyId, item.inventoryItemId, item.quantity]
    );
  }
};

const getOrderItemsForMutation = async (client: PoolClient, orderId: number) => {
  const result = await client.query<OrderMutationItemRow>(
    `
      SELECT id, inventory_item_id, COALESCE(approved_quantity, quantity, 0) AS quantity
      FROM order_items
      WHERE order_id = $1
      ORDER BY id ASC
      FOR UPDATE
    `,
    [orderId]
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    inventoryItemId: Number(row.inventory_item_id),
    quantity: Number(row.quantity ?? 0),
  }));
};

const updatePrescriptionAfterOrderStatus = async (
  client: PoolClient,
  orderId: number,
  prescriptionId: string | null,
  status: OrderStatus
) => {
  if (!prescriptionId) return;

  if (status === "completed" || status === "delivered") {
    const items = await client.query(
      `
        SELECT prescription_item_id, COALESCE(approved_quantity, quantity, 0)::int AS approved_quantity
        FROM order_items
        WHERE order_id = $1
          AND prescription_item_id IS NOT NULL
      `,
      [orderId]
    );

    for (const row of items.rows) {
      await client.query(
        `
          UPDATE prescription_items
          SET
            dispensed_quantity = COALESCE(dispensed_quantity, 0) + $2,
            fulfilled_quantity = COALESCE(fulfilled_quantity, 0) + $2,
            item_status = CASE
              WHEN COALESCE(dispensed_quantity, 0) + $2 >= COALESCE(quantity, 1) THEN 'fulfilled'
              ELSE 'partially_available'
            END
          WHERE id::text = $1
        `,
        [String(row.prescription_item_id), Number(row.approved_quantity ?? 0)]
      );
    }

    const completion = await client.query(
      `
        SELECT
          COUNT(*)::int AS total_items,
          COUNT(*) FILTER (
            WHERE COALESCE(dispensed_quantity, fulfilled_quantity, 0) >= COALESCE(quantity, 1)
          )::int AS fulfilled_items
        FROM prescription_items
        WHERE prescription_id = $1
      `,
      [prescriptionId]
    );
    const totalItems = Number(completion.rows[0]?.total_items ?? 0);
    const fulfilledItems = Number(completion.rows[0]?.fulfilled_items ?? 0);
    const prescriptionStatus = totalItems > 0 && fulfilledItems >= totalItems ? "fulfilled" : "partially_fulfilled";

    await client.query(
      `
        UPDATE prescriptions
        SET
          status = $2,
          dispensed_at = CASE WHEN $2 = 'fulfilled' THEN COALESCE(dispensed_at, NOW()) ELSE dispensed_at END
        WHERE id = $1
      `,
      [prescriptionId, prescriptionStatus]
    );
    return;
  }

  await client.query(`UPDATE prescriptions SET status = $2 WHERE id = $1`, [
    prescriptionId,
    getPrescriptionStatusFromOrderStatus(status),
  ]);
};

const releaseOrderReservations = async (client: PoolClient, pharmacyId: number, orderId: number) => {
  const items = await getOrderItemsForMutation(client, orderId);
  await applyInventoryFinalization(client, pharmacyId, items, "cancel");
};

export const checkoutCart = async (patientId: number, input: CheckoutInput) =>
  withTransaction(async (client) => {
    const { cart, items } = await loadLockedCart(client, patientId);

    if (!items.length) {
      throw new HttpError(409, "Cart is empty");
    }

    const pharmacyId = cart.pharmacy_id === null ? null : Number(cart.pharmacy_id);
    if (!pharmacyId) {
      throw new HttpError(409, "Cart pharmacy is not set");
    }

    const marketplaceProductIds = items.map((item) => Number(item.marketplace_product_id));
    const products = await loadCheckoutProducts(client, pharmacyId, marketplaceProductIds);

    let subtotal = 0;
    let total = 0;
    const paymentMethod: PaymentMethod = input.paymentMethod === "online" ? "online" : "cash";
    const initialOrderStatus: OrderStatus = paymentMethod === "online" ? "pending_payment" : "pending";
    const initialPaymentStatus = paymentMethod === "online" ? "pending" : null;

    for (const item of items) {
      const product = products.get(Number(item.marketplace_product_id));
      const quantity = Number(item.quantity ?? 0);
      assertCheckoutProduct(product, quantity);
      subtotal += normalizeMoney(product?.price) * quantity;
      total += normalizeMoney(product?.discount_price ?? product?.price) * quantity;
    }

    const orderInsert = await client.query(
      `
        INSERT INTO orders (
          patient_id,
          pharmacy_id,
          status,
          subtotal,
          discount_total,
          total,
          currency,
          fulfillment_type,
          payment_method,
          payment_status,
          notes,
          delivery_address,
          delivery_notes,
          delivery_contact_name,
          delivery_contact_phone,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'LKR', $7, $8, $9, $10, $11::jsonb, $12, $13, $14, NOW(), NOW())
        RETURNING id
      `,
      [
        patientId,
        pharmacyId,
        initialOrderStatus,
        normalizeMoney(subtotal),
        normalizeMoney(subtotal - total),
        normalizeMoney(total),
        input.fulfillmentType,
        paymentMethod,
        initialPaymentStatus,
        input.notes ?? null,
        input.deliveryAddress ? JSON.stringify(input.deliveryAddress) : null,
        input.deliveryNotes ?? null,
        input.deliveryContactName ?? null,
        input.deliveryContactPhone ?? null,
      ]
    );

    const orderId = Number(orderInsert.rows[0]?.id);
    if (!orderId) {
      throw new HttpError(500, "Failed to create order");
    }

    for (const item of items) {
      const product = products.get(Number(item.marketplace_product_id));
      const quantity = Number(item.quantity ?? 0);
      const unitPrice = normalizeMoney(product?.discount_price ?? product?.price);
      const totalPrice = normalizeMoney(unitPrice * quantity);

      await client.query(
        `
          INSERT INTO order_items (
            order_id,
            marketplace_product_id,
            inventory_item_id,
            quantity,
            unit_price,
            total_price,
            status,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW(), NOW())
        `,
        [
          orderId,
          Number(item.marketplace_product_id),
          Number(product?.inventory_item_id),
          quantity,
          unitPrice,
          totalPrice,
        ]
      );
    }

    const inventory = await getInventorySchema(client);
    if (!inventory.reservedCol) {
      throw new HttpError(500, "Inventory reservation column is not available");
    }

    for (const item of items) {
      const product = products.get(Number(item.marketplace_product_id));
      await client.query(
        `
          UPDATE inventory
          SET ${quoteIdent(inventory.reservedCol)} = COALESCE(${quoteIdent(
            inventory.reservedCol
          )}, 0) + $3
          WHERE ${quoteIdent(inventory.pharmacyCol)} = $1
            AND ${quoteIdent(inventory.medicineCol)} = $2
        `,
        [pharmacyId, Number(product?.inventory_item_id), Number(item.quantity ?? 0)]
      );
    }

    await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cart.id]);
    await client.query(`UPDATE carts SET pharmacy_id = NULL, updated_at = NOW() WHERE id = $1`, [
      cart.id,
    ]);

    const createdOrder = await getPatientOrder(client, orderId, patientId);

    return {
      message: "Order placed successfully",
      order: createdOrder,
    };
  });

export const getPatientOrders = async (patientId: number) =>
  withTransaction(async (client) => {
    const result = await client.query(
      `
        ${getOrderBaseQuery()}
        WHERE o.patient_id = $1
        ORDER BY o.created_at DESC, o.id DESC
      `,
      [patientId]
    );

    const orders = await Promise.all(result.rows.map((row) => buildOrderSummary(client, row)));
    return { orders };
  });

export const getPatientOrderDetails = async (patientId: number, orderId: number) =>
  withTransaction(async (client) => ({
    order: await getPatientOrder(client, orderId, patientId),
  }));

export const getPharmacyOrders = async (pharmacyUserId: number) =>
  withTransaction(async (client) => {
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacyUserId);
    const result = await client.query(
      `
        ${getOrderBaseQuery()}
        WHERE o.pharmacy_id = $1
        ORDER BY
          CASE o.status
            WHEN 'pending' THEN 1
            WHEN 'confirmed' THEN 2
            WHEN 'preparing' THEN 3
            WHEN 'awaiting_substitution_approval' THEN 4
            WHEN 'partially_ready' THEN 5
            WHEN 'ready_for_pickup' THEN 6
            WHEN 'out_for_delivery' THEN 7
            WHEN 'delivered' THEN 8
            WHEN 'completed' THEN 9
            WHEN 'cancelled' THEN 10
            ELSE 11
          END ASC,
          o.created_at DESC,
          o.id DESC
      `,
      [pharmacy.id]
    );

    const orders = await Promise.all(result.rows.map((row) => buildOrderSummary(client, row)));
    return { orders };
  });

export const getPharmacyOrderDetails = async (pharmacyUserId: number, orderId: number) =>
  withTransaction(async (client) => {
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacyUserId);
    const { summary } = await getPharmacyOrder(client, orderId, pharmacy.id);
    return { order: summary };
  });

export const updatePharmacyOrderStatus = async (
  pharmacyUserId: number,
  input: UpdateOrderStatusInput
) =>
  withTransaction(async (client) => {
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacyUserId);
    const { row } = await getPharmacyOrder(client, input.id, pharmacy.id);
    const currentStatus = row.status as OrderStatus;
    const fulfillmentType = row.fulfillment_type === "delivery" ? "delivery" : "pickup";
    const allowedTransitions = getOrderTransitions(fulfillmentType);

    if (currentStatus === input.status) {
      return {
        message: "Order status unchanged",
        order: await buildOrderSummary(client, row),
      };
    }

    if (TERMINAL_ORDER_STATUSES.has(currentStatus)) {
      throw new HttpError(409, "Completed, rejected, or cancelled orders cannot be changed");
    }

    assertOrderReadyForPharmacyProcessing(row);

    if (!allowedTransitions[currentStatus].includes(input.status)) {
      throw new HttpError(409, `Cannot change order status from ${currentStatus} to ${input.status}`);
    }

    const orderItems = await getOrderItemsForMutation(client, input.id);

    if (input.status === "completed" || input.status === "delivered") {
      await applyInventoryFinalization(client, pharmacy.id, orderItems, "complete");
    } else if (input.status === "cancelled") {
      await applyInventoryFinalization(client, pharmacy.id, orderItems, "cancel");
    }

    await client.query(
      `
        UPDATE orders
        SET
          status = $2,
          delivery_started_at = CASE
            WHEN $2 = 'out_for_delivery' AND delivery_started_at IS NULL THEN NOW()
            ELSE delivery_started_at
          END,
          delivered_at = CASE
            WHEN $2 = 'delivered' AND delivered_at IS NULL THEN NOW()
            ELSE delivered_at
          END,
          pharmacist_note = COALESCE($3, pharmacist_note),
          updated_at = NOW()
        WHERE id = $1
      `,
      [input.id, input.status, input.note ?? null]
    );

    await client.query(
      `
        UPDATE order_items
        SET status = $2, updated_at = NOW()
        WHERE order_id = $1
      `,
      [input.id, input.status]
    );

    const refreshed = await getPharmacyOrder(client, input.id, pharmacy.id);
    await updatePrescriptionAfterOrderStatus(
      client,
      input.id,
      refreshed.summary.prescriptionId,
      input.status
    );
    return {
      message: `Order marked as ${input.status}`,
      order: refreshed.summary,
    };
  });

export const cancelPatientOrder = async (patientId: number, orderId: number) =>
  withTransaction(async (client) => {
    const order = await getPatientOrder(client, orderId, patientId);
    if (!["pending_payment", "pending", "confirmed"].includes(order.status)) {
      throw new HttpError(409, "Order cannot be cancelled from the current state");
    }

    await releaseOrderReservations(client, order.pharmacyId, orderId);
    await client.query(
      `
        UPDATE orders
        SET status = 'cancelled',
            payment_status = CASE
              WHEN LOWER(COALESCE(payment_method, '')) = 'online'
                AND LOWER(COALESCE(payment_status, '')) <> 'paid'
              THEN 'cancelled'
              ELSE payment_status
            END,
            updated_at = NOW()
        WHERE id = $1 AND patient_id = $2
      `,
      [orderId, patientId]
    );

    await updatePrescriptionAfterOrderStatus(client, orderId, order.prescriptionId, "cancelled");
    return { message: "Order cancelled", order: await getPatientOrder(client, orderId, patientId) };
  });

export const rejectPharmacyOrder = async (pharmacyUserId: number, input: RejectOrderInput) =>
  withTransaction(async (client) => {
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacyUserId);
    const { row } = await getPharmacyOrder(client, input.id, pharmacy.id);
    const currentStatus = row.status as OrderStatus;
    if (TERMINAL_ORDER_STATUSES.has(currentStatus)) {
      throw new HttpError(409, "Order cannot be rejected from the current state");
    }

    assertOrderReadyForPharmacyProcessing(row);

    await releaseOrderReservations(client, pharmacy.id, input.id);
    await client.query(
      `
        UPDATE orders
        SET status = 'rejected',
            rejection_reason = $2,
            pharmacist_note = COALESCE($2, pharmacist_note),
            updated_at = NOW()
        WHERE id = $1
      `,
      [input.id, input.reason]
    );
    await client.query(`UPDATE order_items SET status = 'unavailable', note = COALESCE(note, $2), updated_at = NOW() WHERE order_id = $1`, [
      input.id,
      input.reason,
    ]);

    await updatePrescriptionAfterOrderStatus(client, input.id, row.prescription_id ? String(row.prescription_id) : null, "rejected");
    return { message: "Order rejected", order: (await getPharmacyOrder(client, input.id, pharmacy.id)).summary };
  });

export const reviewPharmacyOrder = async (pharmacyUserId: number, input: ReviewOrderInput) =>
  withTransaction(async (client) => {
    const pharmacy = await fetchPharmacyProfileByUserId(pharmacyUserId);
    const { row } = await getPharmacyOrder(client, input.id, pharmacy.id);
    const currentStatus = row.status as OrderStatus;
    if (TERMINAL_ORDER_STATUSES.has(currentStatus)) {
      throw new HttpError(409, "Order cannot be reviewed from the current state");
    }

    assertOrderReadyForPharmacyProcessing(row);

    const inventory = await getInventorySchema(client);
    if (!inventory.reservedCol) {
      throw new HttpError(500, "Inventory reservation column is not available");
    }

    const lockedItems = await client.query<LockedOrderItemRow>(
      `
        SELECT id, inventory_item_id, requested_quantity, approved_quantity, quantity, unit_price
        FROM order_items
        WHERE order_id = $1
        FOR UPDATE
      `,
      [input.id]
    );
    const itemMap = new Map<number, LockedOrderItemRow>(
      lockedItems.rows.map((item) => [Number(item.id), item])
    );

    let availableCount = 0;
    let partialCount = 0;
    let unavailableCount = 0;
    let nextTotal = 0;

    for (const reviewed of input.items) {
      const current = itemMap.get(reviewed.orderItemId);
      if (!current) {
        throw new HttpError(404, "Order item not found for this order");
      }

      const requestedQuantity = Number(current.requested_quantity ?? current.quantity ?? 0);
      if (reviewed.approvedQuantity > requestedQuantity) {
        throw new HttpError(409, "Approved quantity cannot exceed prescribed quantity");
      }

      const currentInventoryItemId = Number(current.inventory_item_id);
      const nextInventoryItemId = reviewed.inventoryItemId ?? currentInventoryItemId;
      const currentApprovedQuantity = Number(current.approved_quantity ?? current.quantity ?? 0);
      const nextApprovedQuantity = reviewed.itemStatus === "unavailable" ? 0 : reviewed.approvedQuantity;

      if (currentInventoryItemId !== nextInventoryItemId && currentApprovedQuantity > 0) {
        await client.query(
          `
            UPDATE inventory
            SET ${quoteIdent(inventory.reservedCol)} = GREATEST(COALESCE(${quoteIdent(inventory.reservedCol)}, 0) - $3, 0)
            WHERE ${quoteIdent(inventory.pharmacyCol)} = $1
              AND ${quoteIdent(inventory.medicineCol)} = $2
          `,
          [pharmacy.id, currentInventoryItemId, currentApprovedQuantity]
        );
      }

      if (nextApprovedQuantity > 0) {
        const inventoryRow = await client.query<InventoryAvailabilityRow>(
          `
            SELECT
              ${quoteIdent(inventory.stockCol)} AS stock_quantity,
              ${quoteIdent(inventory.reservedCol)} AS reserved_quantity
            FROM inventory
            WHERE ${quoteIdent(inventory.pharmacyCol)} = $1
              AND ${quoteIdent(inventory.medicineCol)} = $2
            LIMIT 1
            FOR UPDATE
          `,
          [pharmacy.id, nextInventoryItemId]
        );
        if (!inventoryRow.rows.length) {
          throw new HttpError(404, "Selected inventory item is not available in this pharmacy");
        }
        const stockQuantity = Number(inventoryRow.rows[0].stock_quantity ?? 0);
        const reservedQuantity = Number(inventoryRow.rows[0].reserved_quantity ?? 0);
        const sameItemCredit = currentInventoryItemId === nextInventoryItemId ? currentApprovedQuantity : 0;
        const availableQuantity = stockQuantity - reservedQuantity + sameItemCredit;
        if (availableQuantity < nextApprovedQuantity) {
          throw new HttpError(409, "Not enough stock for one or more medicines");
        }
      }

      const reservationDelta =
        currentInventoryItemId === nextInventoryItemId
          ? nextApprovedQuantity - currentApprovedQuantity
          : nextApprovedQuantity;
      if (reservationDelta !== 0) {
        await client.query(
          `
            UPDATE inventory
            SET ${quoteIdent(inventory.reservedCol)} = GREATEST(COALESCE(${quoteIdent(inventory.reservedCol)}, 0) + $3, 0)
            WHERE ${quoteIdent(inventory.pharmacyCol)} = $1
              AND ${quoteIdent(inventory.medicineCol)} = $2
          `,
          [pharmacy.id, nextInventoryItemId, reservationDelta]
        );
      }

      const unitPrice = normalizeMoney(current.unit_price);
      const totalPrice = normalizeMoney(unitPrice * nextApprovedQuantity);
      await client.query(
        `
          UPDATE order_items
          SET inventory_item_id = $2,
              substituted_inventory_item_id = CASE WHEN $2 <> inventory_item_id THEN $2 ELSE substituted_inventory_item_id END,
              substitution_approved = CASE WHEN $2 <> inventory_item_id THEN TRUE ELSE substitution_approved END,
              approved_quantity = $3,
              requested_quantity = COALESCE(requested_quantity, quantity),
              total_price = $4,
              status = $5,
              substitution_name = $6,
              note = $7,
              updated_at = NOW()
          WHERE id = $1
        `,
        [
          reviewed.orderItemId,
          nextInventoryItemId,
          nextApprovedQuantity,
          totalPrice,
          reviewed.itemStatus,
          reviewed.substitutionName ?? null,
          reviewed.note ?? null,
        ]
      );

      nextTotal += totalPrice;
      if (reviewed.itemStatus === "unavailable" || nextApprovedQuantity === 0) unavailableCount += 1;
      else if (reviewed.itemStatus === "partial" || nextApprovedQuantity < requestedQuantity) partialCount += 1;
      else availableCount += 1;
    }

    const nextStatus: OrderStatus =
      availableCount === 0 && unavailableCount > 0
        ? "rejected"
        : partialCount > 0 || unavailableCount > 0
          ? "partially_ready"
          : "confirmed";

    await client.query(
      `
        UPDATE orders
        SET status = $2,
            total = $3,
            subtotal = GREATEST(subtotal, $3),
            discount_total = GREATEST(GREATEST(subtotal, $3) - $3, 0),
            pharmacist_note = $4,
            rejection_reason = CASE WHEN $2 = 'rejected' THEN COALESCE($4, rejection_reason) ELSE rejection_reason END,
            updated_at = NOW()
        WHERE id = $1
      `,
      [input.id, nextStatus, normalizeMoney(nextTotal), input.pharmacistNote ?? null]
    );

    await updatePrescriptionAfterOrderStatus(client, input.id, row.prescription_id ? String(row.prescription_id) : null, nextStatus);
    return { message: "Order reviewed", order: (await getPharmacyOrder(client, input.id, pharmacy.id)).summary };
  });
