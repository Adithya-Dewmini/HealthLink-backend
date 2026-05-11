import pool from "../../config/db";
import type { PoolClient } from "pg";
import { HttpError } from "../pharmacy/errors";
import { fetchPharmacyProfileByUserId } from "../pharmacy/service";
import { getInventorySchema, quoteIdent } from "../pharmacy/schema";
import type {
  CheckoutInput,
  DeliveryAddress,
  FulfillmentType,
  OrderItemSummary,
  OrderStatus,
  OrderSummary,
  UpdateOrderStatusInput,
} from "./types";

type DbRecord = Record<string, any>;

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
  },
  delivery: {
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
  },
  default: {
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
  unitPrice: normalizeMoney(row.unit_price),
  totalPrice: normalizeMoney(row.total_price),
  status: row.item_status,
  imageUrl: row.image_url ?? null,
  requiresPrescription: Boolean(row.requires_prescription),
});

const loadOrderItems = async (client: PoolClient, orderId: number) => {
  const result = await client.query(
    `
      SELECT
        oi.id AS order_item_id,
        oi.marketplace_product_id,
        oi.inventory_item_id,
        oi.substituted_inventory_item_id,
        oi.substitution_approved,
        oi.quantity,
        oi.unit_price,
        oi.total_price,
        oi.status AS item_status,
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

const buildOrderSummary = async (client: PoolClient, orderRow: DbRecord): Promise<OrderSummary> => ({
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
  fulfillmentType: orderRow.fulfillment_type === "delivery" ? "delivery" : "pickup",
  notes: orderRow.notes ?? null,
  deliveryAddress: normalizeDeliveryAddress(orderRow.delivery_address),
  deliveryNotes: orderRow.delivery_notes ?? null,
  deliveryContactName: orderRow.delivery_contact_name ?? null,
  deliveryContactPhone: orderRow.delivery_contact_phone ?? null,
  deliveryStartedAt: orderRow.delivery_started_at ? new Date(orderRow.delivery_started_at).toISOString() : null,
  deliveredAt: orderRow.delivered_at ? new Date(orderRow.delivered_at).toISOString() : null,
  createdAt: new Date(orderRow.created_at).toISOString(),
  updatedAt: new Date(orderRow.updated_at).toISOString(),
  items: await loadOrderItems(client, Number(orderRow.id)),
});

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

  return new Map(result.rows.map((row) => [Number(row.marketplace_product_id), row]));
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
  const result = await client.query(
    `
      SELECT id, inventory_item_id, quantity
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
          fulfillment_type,
          notes,
          delivery_address,
          delivery_notes,
          delivery_contact_name,
          delivery_contact_phone,
          created_at,
          updated_at
        )
        VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, NOW(), NOW())
        RETURNING id
      `,
      [
        patientId,
        pharmacyId,
        normalizeMoney(subtotal),
        normalizeMoney(subtotal - total),
        normalizeMoney(total),
        input.fulfillmentType,
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
          updated_at = NOW()
        WHERE id = $1
      `,
      [input.id, input.status]
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
    return {
      message: `Order marked as ${input.status}`,
      order: refreshed.summary,
    };
  });
