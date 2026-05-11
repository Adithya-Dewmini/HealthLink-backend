import pool from "../../config/db";
import type { PoolClient } from "pg";
import { HttpError } from "../pharmacy/errors";
import { getInventorySchema, quoteIdent } from "../pharmacy/schema";
import type { CartItemInput, CartItemSummary, CartSummary, UpdateCartItemInput } from "./types";

type DbRecord = Record<string, any>;

const normalizeMoney = (value: unknown) => Number(Number(value ?? 0).toFixed(2));

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

const normalizeCartItem = (row: DbRecord): CartItemSummary => {
  const price = normalizeMoney(row.discount_price ?? row.price);
  const stockQuantity = Number(row.stock_quantity ?? 0);
  const availableStock = Number(row.available_stock ?? stockQuantity);

  return {
    id: Number(row.cart_item_id),
    quantity: Number(row.quantity ?? 0),
    unitPrice: price,
    totalPrice: normalizeMoney(price * Number(row.quantity ?? 0)),
    product: {
      id: String(row.marketplace_product_id),
      inventoryItemId: Number(row.inventory_item_id),
      name: row.name,
      genericName: row.generic_name ?? null,
      brand: row.brand ?? null,
      category: row.category ?? null,
      imageUrl: row.image_url ?? null,
      price: normalizeMoney(row.price),
      discountPrice:
        row.discount_price === null || row.discount_price === undefined
          ? null
          : normalizeMoney(row.discount_price),
      requiresPrescription: Boolean(row.requires_prescription),
      inStock: availableStock > 0,
      stockQuantity,
      availableStock,
      pharmacyId: Number(row.pharmacy_id),
    },
  };
};

const getOrCreateCart = async (client: PoolClient, patientId: number) => {
  const existing = await client.query(
    `
      SELECT id, patient_id, pharmacy_id
      FROM carts
      WHERE patient_id = $1
      LIMIT 1
    `,
    [patientId]
  );

  if (existing.rows.length) {
    return existing.rows[0];
  }

  const created = await client.query(
    `
      INSERT INTO carts (patient_id, pharmacy_id, created_at, updated_at)
      VALUES ($1, NULL, NOW(), NOW())
      RETURNING id, patient_id, pharmacy_id
    `,
    [patientId]
  );

  return created.rows[0];
};

const getMarketplaceProductForCart = async (
  client: PoolClient,
  marketplaceProductId: number,
  lockInventory = false
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
        mp.generic_name,
        mp.brand,
        mp.category,
        mp.image_url,
        mp.price,
        mp.discount_price,
        mp.requires_prescription,
        mp.is_active,
        COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0)::int AS stock_quantity,
        ${reservedExpr}::int AS reserved_quantity,
        GREATEST(COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0) - ${reservedExpr}, 0)::int AS available_stock,
        p.name AS pharmacy_name,
        LOWER(COALESCE(p.verification_status, 'pending')) AS verification_status,
        LOWER(COALESCE(p.status, 'active')) AS pharmacy_status
      FROM marketplace_products mp
      JOIN pharmacies p ON p.id = mp.pharmacy_id
      JOIN inventory inv
        ON inv.${quoteIdent(inventory.pharmacyCol)} = mp.pharmacy_id
       AND inv.${quoteIdent(inventory.medicineCol)} = mp.inventory_item_id
      WHERE mp.id = $1
      LIMIT 1
      ${lockInventory ? "FOR UPDATE OF inv" : ""}
    `,
    [marketplaceProductId]
  );

  return result.rows[0] ?? null;
};

const assertSellableProduct = (product: DbRecord | null, requestedQuantity: number) => {
  if (!product) {
    throw new HttpError(404, "Marketplace product not found");
  }

  if (!product.is_active) {
    throw new HttpError(409, "This product is no longer available");
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
      "Prescription-required products cannot be added to cart in this checkout flow yet"
    );
  }

  const availableStock = Number(product.available_stock ?? 0);
  if (availableStock < requestedQuantity) {
    throw new HttpError(409, "Requested quantity is no longer available");
  }
};

const getCartItems = async (client: PoolClient, cartId: number) => {
  const inventory = await getInventorySchema(client);
  const reservedExpr = getReservedExpr(inventory.reservedCol);
  const result = await client.query(
    `
      SELECT
        ci.id AS cart_item_id,
        ci.quantity,
        mp.id AS marketplace_product_id,
        mp.pharmacy_id,
        mp.inventory_item_id,
        mp.name,
        mp.generic_name,
        mp.brand,
        mp.category,
        mp.image_url,
        mp.price,
        mp.discount_price,
        mp.requires_prescription,
        COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0)::int AS stock_quantity,
        GREATEST(COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0) - ${reservedExpr}, 0)::int AS available_stock
      FROM cart_items ci
      JOIN marketplace_products mp ON mp.id = ci.marketplace_product_id
      JOIN inventory inv
        ON inv.${quoteIdent(inventory.pharmacyCol)} = mp.pharmacy_id
       AND inv.${quoteIdent(inventory.medicineCol)} = mp.inventory_item_id
      WHERE ci.cart_id = $1
      ORDER BY ci.created_at ASC, ci.id ASC
    `,
    [cartId]
  );

  return result.rows.map(normalizeCartItem);
};

const syncCartPharmacy = async (client: PoolClient, cartId: number) => {
  const firstItem = await client.query(
    `
      SELECT mp.pharmacy_id
      FROM cart_items ci
      JOIN marketplace_products mp ON mp.id = ci.marketplace_product_id
      WHERE ci.cart_id = $1
      ORDER BY ci.id ASC
      LIMIT 1
    `,
    [cartId]
  );

  const pharmacyId = firstItem.rows[0]?.pharmacy_id ?? null;
  await client.query(`UPDATE carts SET pharmacy_id = $2, updated_at = NOW() WHERE id = $1`, [
    cartId,
    pharmacyId,
  ]);
};

const buildCartSummary = async (client: PoolClient, patientId: number): Promise<CartSummary> => {
  const cart = await getOrCreateCart(client, patientId);
  const pharmacyResult = cart.pharmacy_id
    ? await client.query(`SELECT name FROM pharmacies WHERE id = $1 LIMIT 1`, [cart.pharmacy_id])
    : { rows: [] as Array<{ name: string }> };
  const items = await getCartItems(client, Number(cart.id));

  const subtotal = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  const total = items.reduce((sum, item) => sum + item.totalPrice, 0);

  return {
    id: Number(cart.id),
    patientId: Number(cart.patient_id),
    pharmacyId: cart.pharmacy_id === null ? null : Number(cart.pharmacy_id),
    pharmacyName: pharmacyResult.rows[0]?.name ?? null,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    subtotal: normalizeMoney(subtotal),
    discountTotal: normalizeMoney(subtotal - total),
    total: normalizeMoney(total),
    items,
  };
};

export const getCart = async (patientId: number) =>
  withTransaction(async (client) => ({
    cart: await buildCartSummary(client, patientId),
  }));

export const addCartItem = async (patientId: number, input: CartItemInput) =>
  withTransaction(async (client) => {
    const cart = await getOrCreateCart(client, patientId);
    const product = await getMarketplaceProductForCart(client, input.marketplaceProductId, true);
    assertSellableProduct(product, input.quantity);

    const existingItem = await client.query(
      `
        SELECT id, quantity
        FROM cart_items
        WHERE cart_id = $1 AND marketplace_product_id = $2
        LIMIT 1
      `,
      [cart.id, input.marketplaceProductId]
    );

    const nextQuantity = existingItem.rows.length
      ? Number(existingItem.rows[0].quantity) + input.quantity
      : input.quantity;

    assertSellableProduct(product, nextQuantity);

    const currentPharmacyId = cart.pharmacy_id === null ? null : Number(cart.pharmacy_id);
    if (currentPharmacyId !== null && currentPharmacyId !== Number(product.pharmacy_id)) {
      throw new HttpError(
        409,
        "Cart can only contain products from one pharmacy. Clear the cart before adding products from another store."
      );
    }

    await client.query(`UPDATE carts SET pharmacy_id = $2, updated_at = NOW() WHERE id = $1`, [
      cart.id,
      Number(product.pharmacy_id),
    ]);

    if (existingItem.rows.length) {
      await client.query(
        `
          UPDATE cart_items
          SET quantity = $3, updated_at = NOW()
          WHERE id = $1 AND cart_id = $2
        `,
        [existingItem.rows[0].id, cart.id, nextQuantity]
      );
    } else {
      await client.query(
        `
          INSERT INTO cart_items (cart_id, marketplace_product_id, quantity, created_at, updated_at)
          VALUES ($1, $2, $3, NOW(), NOW())
        `,
        [cart.id, input.marketplaceProductId, input.quantity]
      );
    }

    return {
      message: "Cart updated successfully",
      cart: await buildCartSummary(client, patientId),
    };
  });

export const updateCartItem = async (patientId: number, input: UpdateCartItemInput) =>
  withTransaction(async (client) => {
    const cart = await getOrCreateCart(client, patientId);
    const existing = await client.query(
      `
        SELECT ci.id, ci.quantity, ci.marketplace_product_id
        FROM cart_items ci
        WHERE ci.id = $1 AND ci.cart_id = $2
        LIMIT 1
      `,
      [input.id, cart.id]
    );

    if (!existing.rows.length) {
      throw new HttpError(404, "Cart item not found");
    }

    const product = await getMarketplaceProductForCart(
      client,
      Number(existing.rows[0].marketplace_product_id),
      true
    );
    assertSellableProduct(product, input.quantity);

    await client.query(
      `
        UPDATE cart_items
        SET quantity = $3, updated_at = NOW()
        WHERE id = $1 AND cart_id = $2
      `,
      [input.id, cart.id, input.quantity]
    );

    await syncCartPharmacy(client, Number(cart.id));

    return {
      message: "Cart item updated successfully",
      cart: await buildCartSummary(client, patientId),
    };
  });

export const deleteCartItem = async (patientId: number, cartItemId: number) =>
  withTransaction(async (client) => {
    const cart = await getOrCreateCart(client, patientId);
    const result = await client.query(`DELETE FROM cart_items WHERE id = $1 AND cart_id = $2`, [
      cartItemId,
      cart.id,
    ]);

    if (!result.rowCount) {
      throw new HttpError(404, "Cart item not found");
    }

    await syncCartPharmacy(client, Number(cart.id));

    return {
      message: "Cart item removed successfully",
      cart: await buildCartSummary(client, patientId),
    };
  });
