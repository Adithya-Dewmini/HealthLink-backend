import pool from "../../config/db";
import type { PoolClient } from "pg";
import { HttpError } from "../pharmacy/errors";
import { getInventorySchema, quoteIdent } from "../pharmacy/schema";
import type { OrderStatus } from "../orders/types";
import type {
  CreatePrescriptionOrderInput,
  PrescriptionBuildCartResponse,
  PrescriptionCartMatchItem,
  PrescriptionPharmacyMatch,
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

const getReservedExpr = (reservedCol: string | null) =>
  reservedCol ? `COALESCE(inv.${quoteIdent(reservedCol)}, 0)` : "0";

const getPrescriptionForPatient = async (
  client: PoolClient,
  prescriptionId: string,
  patientId: number
) => {
  const result = await client.query(
    `
      SELECT
        p.id,
        p.status,
        p.dispensed_at,
        c.patient_id
      FROM prescriptions p
      JOIN consultations c ON c.id = p.consultation_id
      WHERE p.id = $1
        AND c.patient_id = $2
      LIMIT 1
    `,
    [prescriptionId, patientId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, "Prescription not found");
  }

  if (Boolean(row.dispensed_at) || String(row.status || "").toLowerCase() === "completed") {
    throw new HttpError(409, "Prescription has already been fully dispensed");
  }

  return row;
};

const getPrescriptionItems = async (client: PoolClient, prescriptionId: string) => {
  const result = await client.query(
    `
      SELECT
        pi.id AS prescription_item_id,
        COALESCE(pi.medicine_id, m.id) AS medicine_id,
        COALESCE(m.name, pi.medicine_name) AS medicine_name,
        COALESCE(pi.quantity, 1) AS required_quantity,
        COALESCE(pi.dispensed_quantity, 0) AS dispensed_quantity
      FROM prescription_items pi
      LEFT JOIN medicines m
        ON m.id = pi.medicine_id
        OR (pi.medicine_id IS NULL AND pi.medicine_name IS NOT NULL AND LOWER(m.name) = LOWER(pi.medicine_name))
      WHERE pi.prescription_id = $1
      ORDER BY pi.id ASC
    `,
    [prescriptionId]
  );

  if (!result.rows.length) {
    throw new HttpError(404, "No prescription items found");
  }

  const items = result.rows
    .map((row) => ({
      prescriptionItemId: Number(row.prescription_item_id),
      medicineId: row.medicine_id ? Number(row.medicine_id) : null,
      medicineName: row.medicine_name ?? "Medicine",
      requiredQuantity: Number(row.required_quantity ?? 1),
      dispensedQuantity: Number(row.dispensed_quantity ?? 0),
    }))
    .map((row) => ({
      ...row,
      remainingQuantity: Math.max(0, row.requiredQuantity - row.dispensedQuantity),
    }))
    .filter((row) => row.remainingQuantity > 0);

  if (!items.length) {
    throw new HttpError(409, "Prescription has already been fully fulfilled");
  }

  return items;
};

const getMarketplaceCoverageRows = async (client: PoolClient, medicineIds: number[], lockInventory = false) => {
  const inventory = await getInventorySchema(client);
  const reservedExpr = getReservedExpr(inventory.reservedCol);
  const result = await client.query(
    `
      SELECT
        mp.id AS marketplace_product_id,
        mp.pharmacy_id,
        mp.inventory_item_id,
        mp.name AS product_name,
        mp.price,
        mp.discount_price,
        mp.requires_prescription,
        mp.is_active,
        p.name AS pharmacy_name,
        p.location AS pharmacy_location,
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
      WHERE mp.inventory_item_id = ANY($1::int[])
        AND mp.is_active = TRUE
        AND LOWER(COALESCE(p.verification_status, 'pending')) = 'approved'
        AND LOWER(COALESCE(p.status, 'active')) NOT IN ('inactive', 'disabled', 'closed', 'suspended')
      ${lockInventory ? "FOR UPDATE OF inv" : ""}
    `,
    [medicineIds]
  );

  return result.rows;
};

const buildPharmacyMatches = (
  prescriptionId: string,
  prescriptionItems: Array<{
    prescriptionItemId: number;
    medicineId: number | null;
    medicineName: string;
    remainingQuantity: number;
  }>,
  rows: DbRecord[]
): PrescriptionBuildCartResponse => {
  const totalRequired = prescriptionItems.reduce((sum, item) => sum + item.remainingQuantity, 0);
  const grouped = new Map<number, PrescriptionPharmacyMatch>();

  for (const row of rows) {
    const pharmacyId = Number(row.pharmacy_id);
    const existing = grouped.get(pharmacyId);
    if (!existing) {
      grouped.set(pharmacyId, {
        pharmacy: {
          id: pharmacyId,
          name: row.pharmacy_name,
          location: row.pharmacy_location ?? null,
        },
        coveragePercentage: 0,
        availableItems: [],
        missingItems: [],
        estimatedTotal: 0,
        fullyAvailable: false,
      });
    }
  }

  for (const match of grouped.values()) {
    let matchedQuantity = 0;
    for (const item of prescriptionItems) {
      const row = rows.find(
        (candidate) =>
          Number(candidate.pharmacy_id) === match.pharmacy.id &&
          Number(candidate.inventory_item_id) === Number(item.medicineId)
      );

      if (!row) {
        match.missingItems.push({
          prescriptionItemId: item.prescriptionItemId,
          medicineName: item.medicineName,
          requiredQuantity: item.remainingQuantity,
          availableQuantity: 0,
          missingQuantity: item.remainingQuantity,
        });
        continue;
      }

      const availableQuantity = Math.min(Number(row.available_stock ?? 0), item.remainingQuantity);
      const missingQuantity = Math.max(0, item.remainingQuantity - availableQuantity);
      const unitPrice = normalizeMoney(row.discount_price ?? row.price);
      const totalPrice = normalizeMoney(unitPrice * availableQuantity);

      if (availableQuantity > 0) {
        const availableItem: PrescriptionCartMatchItem = {
          prescriptionItemId: item.prescriptionItemId,
          inventoryItemId: Number(row.inventory_item_id),
          marketplaceProductId: Number(row.marketplace_product_id),
          medicineName: item.medicineName,
          requiredQuantity: item.remainingQuantity,
          availableQuantity,
          missingQuantity,
          unitPrice,
          totalPrice,
          requiresPrescription: Boolean(row.requires_prescription),
        };
        match.availableItems.push(availableItem);
        match.estimatedTotal = normalizeMoney(match.estimatedTotal + totalPrice);
        matchedQuantity += availableQuantity;
      }

      if (missingQuantity > 0) {
        match.missingItems.push({
          prescriptionItemId: item.prescriptionItemId,
          medicineName: item.medicineName,
          requiredQuantity: item.remainingQuantity,
          availableQuantity,
          missingQuantity,
        });
      }
    }

    match.coveragePercentage =
      totalRequired > 0 ? Number(((matchedQuantity / totalRequired) * 100).toFixed(2)) : 0;
    match.fullyAvailable = match.missingItems.length === 0;
  }

  const matches = Array.from(grouped.values())
    .filter((match) => match.availableItems.length > 0)
    .sort((a, b) => {
      if (a.fullyAvailable !== b.fullyAvailable) {
        return a.fullyAvailable ? -1 : 1;
      }
      if (a.estimatedTotal !== b.estimatedTotal) {
        return a.estimatedTotal - b.estimatedTotal;
      }
      if (a.coveragePercentage !== b.coveragePercentage) {
        return b.coveragePercentage - a.coveragePercentage;
      }
      return a.pharmacy.name.localeCompare(b.pharmacy.name);
    });

  return {
    prescriptionId: String(prescriptionId),
    matches,
  };
};

export const buildPrescriptionCartMatches = async (
  patientId: number,
  prescriptionId: string
): Promise<PrescriptionBuildCartResponse> =>
  withTransaction(async (client) => {
    await getPrescriptionForPatient(client, prescriptionId, patientId);
    const items = await getPrescriptionItems(client, prescriptionId);
    const medicineIds = Array.from(
      new Set(items.map((item) => item.medicineId).filter((value): value is number => Number.isInteger(value)))
    );

    if (!medicineIds.length) {
      throw new HttpError(409, "Prescription medicines are not mapped to inventory items yet");
    }

    const rows = await getMarketplaceCoverageRows(client, medicineIds);
    return buildPharmacyMatches(prescriptionId, items, rows);
  });

export const createPrescriptionLinkedOrder = async (
  patientId: number,
  prescriptionId: string,
  input: CreatePrescriptionOrderInput
) =>
  withTransaction(async (client) => {
    await getPrescriptionForPatient(client, prescriptionId, patientId);
    const items = await getPrescriptionItems(client, prescriptionId);
    const medicineIds = Array.from(
      new Set(items.map((item) => item.medicineId).filter((value): value is number => Number.isInteger(value)))
    );

    if (!medicineIds.length) {
      throw new HttpError(409, "Prescription medicines are not mapped to inventory items yet");
    }

    const rows = await getMarketplaceCoverageRows(client, medicineIds, true);
    const matchPayload = buildPharmacyMatches(prescriptionId, items, rows);
    const match = matchPayload.matches.find((entry) => entry.pharmacy.id === input.pharmacyId);

    if (!match || match.availableItems.length === 0) {
      throw new HttpError(404, "Selected pharmacy cannot fulfill this prescription");
    }

    if (!match.fullyAvailable && !input.acceptPartial) {
      throw new HttpError(
        409,
        "Selected pharmacy does not fully cover this prescription. Accept partial fulfillment to continue."
      );
    }

    const orderStatus: OrderStatus = match.fullyAvailable ? "pending" : "partially_ready";
    const subtotal = match.availableItems.reduce((sum, item) => sum + item.unitPrice * item.requiredQuantity, 0);
    const total = match.availableItems.reduce((sum, item) => sum + item.totalPrice, 0);

    const orderResult = await client.query(
      `
        INSERT INTO orders (
          patient_id,
          pharmacy_id,
          prescription_id,
          status,
          subtotal,
          discount_total,
          total,
          fulfillment_type,
          notes,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pickup', $8, NOW(), NOW())
        RETURNING id
      `,
      [
        patientId,
        input.pharmacyId,
        prescriptionId,
        orderStatus,
        normalizeMoney(subtotal),
        normalizeMoney(subtotal - total),
        normalizeMoney(total),
        input.notes ?? null,
      ]
    );

    const orderId = Number(orderResult.rows[0]?.id);
    if (!orderId) {
      throw new HttpError(500, "Failed to create prescription order");
    }

    const inventory = await getInventorySchema(client);
    if (!inventory.reservedCol) {
      throw new HttpError(500, "Inventory reservation column is not available");
    }

    for (const item of match.availableItems) {
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        `,
        [
          orderId,
          item.marketplaceProductId,
          item.inventoryItemId,
          item.availableQuantity,
          item.unitPrice,
          item.totalPrice,
          orderStatus,
        ]
      );

      await client.query(
        `
          UPDATE inventory
          SET ${quoteIdent(inventory.reservedCol)} = COALESCE(${quoteIdent(
            inventory.reservedCol
          )}, 0) + $3
          WHERE ${quoteIdent(inventory.pharmacyCol)} = $1
            AND ${quoteIdent(inventory.medicineCol)} = $2
        `,
        [input.pharmacyId, item.inventoryItemId, item.availableQuantity]
      );
    }

    const orderRow = await client.query(
      `
        SELECT o.*, p.name AS pharmacy_name
        FROM orders o
        JOIN pharmacies p ON p.id = o.pharmacy_id
        WHERE o.id = $1
        LIMIT 1
      `,
      [orderId]
    );

    const orderItems = await client.query(
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

    return {
      message: match.fullyAvailable
        ? "Prescription order created successfully"
        : "Partial prescription order created successfully",
      order: {
        id: orderId,
        patientId,
        patientName: null,
        patientEmail: null,
        pharmacyId: input.pharmacyId,
        prescriptionId,
        pharmacyName: orderRow.rows[0]?.pharmacy_name ?? "Pharmacy",
        status: orderStatus,
        subtotal: normalizeMoney(subtotal),
        discountTotal: normalizeMoney(subtotal - total),
        total: normalizeMoney(total),
        fulfillmentType: "pickup" as const,
        notes: input.notes ?? null,
        deliveryAddress: null,
        deliveryNotes: null,
        deliveryContactName: null,
        deliveryContactPhone: null,
        deliveryStartedAt: null,
        deliveredAt: null,
        createdAt: new Date(orderRow.rows[0]?.created_at ?? new Date()).toISOString(),
        updatedAt: new Date(orderRow.rows[0]?.updated_at ?? new Date()).toISOString(),
        items: orderItems.rows.map((row) => ({
          id: Number(row.order_item_id),
          marketplaceProductId: Number(row.marketplace_product_id),
          inventoryItemId: Number(row.inventory_item_id),
          substitutedInventoryItemId:
            row.substituted_inventory_item_id === null ||
            row.substituted_inventory_item_id === undefined
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
        })),
      },
      fulfillment: {
        fullyAvailable: match.fullyAvailable,
        coveragePercentage: match.coveragePercentage,
        missingItems: match.missingItems,
      },
    };
  });
