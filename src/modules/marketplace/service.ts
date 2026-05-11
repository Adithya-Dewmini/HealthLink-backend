import pool from "../../config/db";
import type { PoolClient } from "pg";
import { HttpError } from "../pharmacy/errors";
import { getInventorySchema, quoteIdent } from "../pharmacy/schema";
import type {
  CreateMarketplaceProductInput,
  MarketplaceStoreProduct,
  MarketplaceStoreResponse,
  UpdateMarketplaceProductInput,
  UpdateMarketplaceVisibilityInput,
} from "./types";

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

const normalizeStoreProduct = (row: DbRecord): MarketplaceStoreProduct => ({
  id: String(row.id),
  inventoryItemId: Number(row.inventory_item_id),
  name: row.name,
  genericName: row.generic_name ?? null,
  brand: row.brand ?? null,
  description: row.description ?? null,
  category: row.category ?? null,
  imageUrl: row.image_url ?? null,
  price: normalizeMoney(row.price),
  discountPrice:
    row.discount_price === null || row.discount_price === undefined
      ? null
      : normalizeMoney(row.discount_price),
  requiresPrescription: Boolean(row.requires_prescription),
  isFeatured: Boolean(row.is_featured),
  isActive: Boolean(row.is_active),
  inStock: Number(row.stock_quantity ?? 0) > 0,
  stockQuantity: Number(row.stock_quantity ?? 0),
  pharmacyId: Number(row.pharmacy_id),
});

const fetchApprovedOperationalPharmacy = async (client: PoolClient, pharmacyId: number | string) => {
  const result = await client.query<{
    id: number;
    name: string;
    location: string | null;
    image_url: string | null;
    logo_url: string | null;
    cover_image_url: string | null;
    rating: number | null;
    status: string | null;
    verification_status: string;
  }>(
    `
      SELECT
        p.id,
        p.name,
        p.location,
        p.image_url,
        p.logo_url,
        p.cover_image_url,
        p.rating::float AS rating,
        p.status,
        LOWER(COALESCE(p.verification_status, 'pending')) AS verification_status
      FROM pharmacies p
      WHERE p.id = $1
        AND LOWER(COALESCE(p.verification_status, 'pending')) = 'approved'
        AND LOWER(COALESCE(p.status, 'active')) NOT IN ('inactive', 'disabled', 'closed', 'suspended')
      LIMIT 1
    `,
    [pharmacyId]
  );

  return result.rows[0] ?? null;
};

const getInventoryBackedMedicine = async (
  client: PoolClient,
  pharmacyId: number | string,
  inventoryItemId: number
) => {
  const inventory = await getInventorySchema(client);
  const result = await client.query(
    `
      SELECT
        m.id AS inventory_item_id,
        m.name,
        m.generic_name,
        m.description,
        m.image_url,
        c.name AS category_name,
        b.name AS brand_name,
        inv.${quoteIdent(inventory.stockCol)} AS stock_quantity
      FROM inventory inv
      JOIN medicines m
        ON m.id = inv.${quoteIdent(inventory.medicineCol)}
      LEFT JOIN categories c ON c.id = m.category_id
      LEFT JOIN brands b ON b.id = m.brand_id
      WHERE inv.${quoteIdent(inventory.pharmacyCol)} = $1
        AND inv.${quoteIdent(inventory.medicineCol)} = $2
      LIMIT 1
    `,
    [pharmacyId, inventoryItemId]
  );

  return result.rows[0] ?? null;
};

const backfillMarketplaceProductsForPharmacy = async (
  client: PoolClient,
  pharmacyId: number | string
) => {
  const inventory = await getInventorySchema(client);
  const priceExpr = inventory.priceCol
    ? `COALESCE(inv.${quoteIdent(inventory.priceCol)}, m.price, 0)`
    : "COALESCE(m.price, 0)";
  await client.query(
    `
      INSERT INTO marketplace_products (
        pharmacy_id,
        inventory_item_id,
        name,
        generic_name,
        brand,
        description,
        category,
        price,
        discount_price,
        image_url,
        requires_prescription,
        is_featured,
        is_active,
        created_at,
        updated_at
      )
      SELECT
        $1,
        m.id,
        m.name,
        m.generic_name,
        b.name,
        m.description,
        c.name,
        ${priceExpr},
        NULL,
        m.image_url,
        FALSE,
        FALSE,
        TRUE,
        NOW(),
        NOW()
      FROM inventory inv
      JOIN medicines m
        ON m.id = inv.${quoteIdent(inventory.medicineCol)}
      LEFT JOIN categories c ON c.id = m.category_id
      LEFT JOIN brands b ON b.id = m.brand_id
      WHERE inv.${quoteIdent(inventory.pharmacyCol)} = $1
        AND NOT EXISTS (
          SELECT 1
          FROM marketplace_products mp
          WHERE mp.pharmacy_id = $1
            AND mp.inventory_item_id = m.id
        )
    `,
    [pharmacyId]
  );
};

const getStoreProducts = async (
  client: PoolClient,
  pharmacyId: number | string,
  options: { featuredOnly?: boolean; productId?: number | string; search?: string } = {}
) => {
  const inventory = await getInventorySchema(client);
  const params: Array<string | number> = [pharmacyId];
  const whereParts = [
    `mp.pharmacy_id = $1`,
    `mp.is_active = TRUE`,
    `LOWER(COALESCE(p.verification_status, 'pending')) = 'approved'`,
    `LOWER(COALESCE(p.status, 'active')) NOT IN ('inactive', 'disabled', 'closed', 'suspended')`,
  ];

  if (options.featuredOnly) {
    whereParts.push("mp.is_featured = TRUE");
  }

  if (options.productId !== undefined) {
    params.push(Number(options.productId));
    whereParts.push(`mp.id = $${params.length}`);
  }

  if (options.search) {
    params.push(`%${options.search.trim().toLowerCase()}%`);
    whereParts.push(`
      (
        LOWER(mp.name) LIKE $${params.length}
        OR LOWER(COALESCE(mp.generic_name, '')) LIKE $${params.length}
        OR LOWER(COALESCE(mp.brand, '')) LIKE $${params.length}
      )
    `);
  }

  const result = await client.query(
    `
      SELECT
        mp.id,
        mp.pharmacy_id,
        mp.inventory_item_id,
        mp.name,
        mp.generic_name,
        mp.brand,
        mp.description,
        mp.category,
        mp.price,
        mp.discount_price,
        mp.image_url,
        mp.requires_prescription,
        mp.is_featured,
        mp.is_active,
        COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0)::int AS stock_quantity
      FROM marketplace_products mp
      JOIN pharmacies p ON p.id = mp.pharmacy_id
      JOIN inventory inv
        ON inv.${quoteIdent(inventory.pharmacyCol)} = mp.pharmacy_id
       AND inv.${quoteIdent(inventory.medicineCol)} = mp.inventory_item_id
      WHERE ${whereParts.join(" AND ")}
      ORDER BY mp.is_featured DESC, mp.created_at DESC, mp.id DESC
    `,
    params
  );

  return result.rows.map(normalizeStoreProduct);
};

export const getMarketplaceStoreByPharmacyId = async (
  pharmacyId: number | string
): Promise<MarketplaceStoreResponse> =>
  withTransaction(async (client) => {
    const pharmacy = await fetchApprovedOperationalPharmacy(client, pharmacyId);
    if (!pharmacy) {
      throw new HttpError(404, "Approved pharmacy storefront not found");
    }

    await backfillMarketplaceProductsForPharmacy(client, pharmacyId);

    const products = await getStoreProducts(client, pharmacyId);
    const featuredProducts = products.filter((product) => product.isFeatured);
    const categories = Array.from(
      new Set(
        products
          .map((product) => product.category?.trim())
          .filter((value): value is string => Boolean(value))
      )
    ).sort((a, b) => a.localeCompare(b));

    return {
      pharmacy: {
        id: pharmacy.id,
        name: pharmacy.name,
        location: pharmacy.location,
        imageUrl: pharmacy.image_url,
        logoUrl: pharmacy.logo_url,
        coverImageUrl: pharmacy.cover_image_url,
        rating: pharmacy.rating,
        status: pharmacy.status,
        verificationStatus: pharmacy.verification_status,
      },
      categories,
      featuredProducts,
      products,
    };
  });

export const searchMarketplaceProducts = async (query: string) =>
  withTransaction(async (client) => {
    const approvedPharmacies = await client.query<{ id: number }>(
      `
        SELECT id
        FROM pharmacies
        WHERE LOWER(COALESCE(verification_status, 'pending')) = 'approved'
          AND LOWER(COALESCE(status, 'active')) NOT IN ('inactive', 'disabled', 'closed', 'suspended')
      `
    );

    for (const row of approvedPharmacies.rows) {
      await backfillMarketplaceProductsForPharmacy(client, row.id);
    }

    const inventory = await getInventorySchema(client);
    const result = await client.query(
      `
        SELECT
          mp.id,
          mp.pharmacy_id,
          mp.inventory_item_id,
          mp.name,
          mp.generic_name,
          mp.brand,
          mp.description,
          mp.category,
          mp.price,
          mp.discount_price,
          mp.image_url,
          mp.requires_prescription,
          mp.is_featured,
          mp.is_active,
          COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0)::int AS stock_quantity,
          p.name AS pharmacy_name
        FROM marketplace_products mp
        JOIN pharmacies p ON p.id = mp.pharmacy_id
        JOIN inventory inv
          ON inv.${quoteIdent(inventory.pharmacyCol)} = mp.pharmacy_id
         AND inv.${quoteIdent(inventory.medicineCol)} = mp.inventory_item_id
        WHERE mp.is_active = TRUE
          AND LOWER(COALESCE(p.verification_status, 'pending')) = 'approved'
          AND LOWER(COALESCE(p.status, 'active')) NOT IN ('inactive', 'disabled', 'closed', 'suspended')
          AND (
            LOWER(mp.name) LIKE $1
            OR LOWER(COALESCE(mp.generic_name, '')) LIKE $1
            OR LOWER(COALESCE(mp.brand, '')) LIKE $1
          )
        ORDER BY mp.is_featured DESC, COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0) DESC, mp.created_at DESC
        LIMIT 50
      `,
      [`%${query.trim().toLowerCase()}%`]
    );

    return {
      items: result.rows.map((row) => ({
        ...normalizeStoreProduct(row),
        pharmacyName: row.pharmacy_name,
      })),
    };
  });

export const getMarketplaceProductDetails = async (productId: number | string) =>
  withTransaction(async (client) => {
    const pharmacyLookup = await client.query<{ pharmacy_id: number }>(
      `SELECT pharmacy_id FROM marketplace_products WHERE id = $1 LIMIT 1`,
      [productId]
    );
    if (pharmacyLookup.rows[0]?.pharmacy_id) {
      await backfillMarketplaceProductsForPharmacy(client, pharmacyLookup.rows[0].pharmacy_id);
    }

    const inventory = await getInventorySchema(client);
    const result = await client.query(
      `
        SELECT
          mp.id,
          mp.pharmacy_id,
          mp.inventory_item_id,
          mp.name,
          mp.generic_name,
          mp.brand,
          mp.description,
          mp.category,
          mp.price,
          mp.discount_price,
          mp.image_url,
          mp.requires_prescription,
          mp.is_featured,
          mp.is_active,
          COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0)::int AS stock_quantity
        FROM marketplace_products mp
        JOIN pharmacies p ON p.id = mp.pharmacy_id
        JOIN inventory inv
          ON inv.${quoteIdent(inventory.pharmacyCol)} = mp.pharmacy_id
         AND inv.${quoteIdent(inventory.medicineCol)} = mp.inventory_item_id
        WHERE mp.id = $1
          AND mp.is_active = TRUE
          AND LOWER(COALESCE(p.verification_status, 'pending')) = 'approved'
          AND LOWER(COALESCE(p.status, 'active')) NOT IN ('inactive', 'disabled', 'closed', 'suspended')
        LIMIT 1
      `,
      [productId]
    );

    if (!result.rows.length) {
      throw new HttpError(404, "Marketplace product not found");
    }

    return normalizeStoreProduct(result.rows[0]);
  });

export const createMarketplaceProduct = async (
  pharmacyId: number | string,
  input: CreateMarketplaceProductInput
) =>
  withTransaction(async (client) => {
    const inventoryBackedMedicine = await getInventoryBackedMedicine(
      client,
      pharmacyId,
      input.inventoryItemId
    );

    if (!inventoryBackedMedicine) {
      throw new HttpError(404, "Inventory item not found for this pharmacy");
    }

    const duplicateCheck = await client.query(
      `
        SELECT id
        FROM marketplace_products
        WHERE pharmacy_id = $1 AND inventory_item_id = $2
        LIMIT 1
      `,
      [pharmacyId, input.inventoryItemId]
    );

    if (duplicateCheck.rows.length) {
      throw new HttpError(409, "This inventory item is already published to the marketplace");
    }

    const result = await client.query(
      `
        INSERT INTO marketplace_products (
          pharmacy_id,
          inventory_item_id,
          name,
          generic_name,
          brand,
          description,
          category,
          price,
          discount_price,
          image_url,
          requires_prescription,
          is_featured,
          is_active,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
        RETURNING id
      `,
      [
        pharmacyId,
        input.inventoryItemId,
        input.name || inventoryBackedMedicine.name,
        input.genericName ?? inventoryBackedMedicine.generic_name ?? null,
        input.brand ?? inventoryBackedMedicine.brand_name ?? null,
        input.description ?? inventoryBackedMedicine.description ?? null,
        input.category ?? inventoryBackedMedicine.category_name ?? null,
        input.price,
        input.discountPrice ?? null,
        input.imageUrl ?? inventoryBackedMedicine.image_url ?? null,
        input.requiresPrescription ?? false,
        input.isFeatured ?? false,
        input.isActive ?? true,
      ]
    );

    const productId = result.rows[0]?.id;
    if (!productId) {
      throw new HttpError(500, "Failed to publish marketplace product");
    }

    return {
      message: "Marketplace product published successfully",
      product: await getMarketplaceProductForPharmacy(client, pharmacyId, Number(productId)),
    };
  });

const getMarketplaceProductForPharmacy = async (
  client: PoolClient,
  pharmacyId: number | string,
  productId: number
) => {
  const inventory = await getInventorySchema(client);
  const result = await client.query(
    `
      SELECT
        mp.id,
        mp.pharmacy_id,
        mp.inventory_item_id,
        mp.name,
        mp.generic_name,
        mp.brand,
        mp.description,
        mp.category,
        mp.price,
        mp.discount_price,
        mp.image_url,
        mp.requires_prescription,
        mp.is_featured,
        mp.is_active,
        COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0)::int AS stock_quantity
      FROM marketplace_products mp
      JOIN inventory inv
        ON inv.${quoteIdent(inventory.pharmacyCol)} = mp.pharmacy_id
       AND inv.${quoteIdent(inventory.medicineCol)} = mp.inventory_item_id
      WHERE mp.pharmacy_id = $1
        AND mp.id = $2
      LIMIT 1
    `,
    [pharmacyId, productId]
  );

  if (!result.rows.length) {
    throw new HttpError(404, "Marketplace product not found");
  }

  return normalizeStoreProduct(result.rows[0]);
};

export const updateMarketplaceProduct = async (
  pharmacyId: number | string,
  input: UpdateMarketplaceProductInput
) =>
  withTransaction(async (client) => {
    const existing = await getMarketplaceProductForPharmacy(client, pharmacyId, input.id);

    const nextPrice = input.price ?? existing.price;
    const nextDiscountPrice =
      input.discountPrice !== undefined ? input.discountPrice : existing.discountPrice;

    if (nextDiscountPrice !== null && nextDiscountPrice >= nextPrice) {
      throw new HttpError(400, "discount_price must be less than price");
    }

    await client.query(
      `
        UPDATE marketplace_products
        SET
          name = $3,
          generic_name = $4,
          brand = $5,
          description = $6,
          category = $7,
          price = $8,
          discount_price = $9,
          image_url = $10,
          requires_prescription = $11,
          is_featured = $12,
          is_active = $13,
          updated_at = NOW()
        WHERE pharmacy_id = $1
          AND id = $2
      `,
      [
        pharmacyId,
        input.id,
        input.name ?? existing.name,
        input.genericName !== undefined ? input.genericName : existing.genericName,
        input.brand !== undefined ? input.brand : existing.brand,
        input.description !== undefined ? input.description : existing.description,
        input.category !== undefined ? input.category : existing.category,
        nextPrice,
        nextDiscountPrice,
        input.imageUrl !== undefined ? input.imageUrl : existing.imageUrl,
        input.requiresPrescription ?? existing.requiresPrescription,
        input.isFeatured ?? existing.isFeatured,
        input.isActive ?? existing.isActive,
      ]
    );

    return {
      message: "Marketplace product updated successfully",
      product: await getMarketplaceProductForPharmacy(client, pharmacyId, input.id),
    };
  });

export const updateMarketplaceProductVisibility = async (
  pharmacyId: number | string,
  input: UpdateMarketplaceVisibilityInput
) =>
  withTransaction(async (client) => {
    await getMarketplaceProductForPharmacy(client, pharmacyId, input.id);
    await client.query(
      `
        UPDATE marketplace_products
        SET is_active = $3, updated_at = NOW()
        WHERE pharmacy_id = $1
          AND id = $2
      `,
      [pharmacyId, input.id, input.isActive]
    );

    return {
      message: `Marketplace product ${input.isActive ? "enabled" : "hidden"} successfully`,
      product: await getMarketplaceProductForPharmacy(client, pharmacyId, input.id),
    };
  });
