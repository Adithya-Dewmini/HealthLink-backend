import pool from "../../config/db";
import type { PoolClient } from "pg";
import { HttpError } from "./errors";
import {
  getDemandLogsSchema,
  getInventorySchema,
  getPrescriptionSchema,
  getSaleItemsSchema,
  getSalesSchema,
  quoteIdent,
} from "./schema";
import type {
  CreateLookupInput,
  CreateMedicineInput,
  DemandItemInput,
  RestockMedicineInput,
  SelectedItemInput,
  UpdateMedicineInput,
} from "./validation";

type DbRecord = Record<string, any>;

const normalizeMoney = (value: number) => Number(value.toFixed(2));
const normalizeDbId = (value: unknown) =>
  typeof value === "number" ? value : String(value ?? "");
let prescriptionItemDispenseColumnsReady = false;
let medicineClinicalColumnsReady = false;

const ensurePrescriptionItemDispenseColumns = async (client: PoolClient) => {
  if (prescriptionItemDispenseColumnsReady) return;
  await client.query(`
    ALTER TABLE prescription_items
      ADD COLUMN IF NOT EXISTS dispensed_quantity INTEGER DEFAULT 0
  `);
  await client.query(`
    UPDATE prescription_items
    SET dispensed_quantity = 0
    WHERE dispensed_quantity IS NULL
  `);
  prescriptionItemDispenseColumnsReady = true;
};

const ensureMedicineClinicalColumns = async (client: PoolClient) => {
  if (medicineClinicalColumnsReady) return;
  await client.query(`
    ALTER TABLE medicines
      ADD COLUMN IF NOT EXISTS generic_name TEXT,
      ADD COLUMN IF NOT EXISTS active_ingredient TEXT,
      ADD COLUMN IF NOT EXISTS strength TEXT,
      ADD COLUMN IF NOT EXISTS dosage_form TEXT
  `);
  medicineClinicalColumnsReady = true;
};

const buildInsertParts = (payload: Record<string, any>) => {
  const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
  return {
    columns: entries.map(([key]) => quoteIdent(key)).join(", "),
    placeholders: entries.map((_, index) => `$${index + 1}`).join(", "),
    values: entries.map(([, value]) => value),
  };
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

const getPrescriptionItems = async (
  client: PoolClient,
  prescriptionId: unknown,
  prescriptionItemIds: number[]
) => {
  await ensurePrescriptionItemDispenseColumns(client);
  const query = await client.query(
    `
      SELECT
        pi.id AS prescription_item_id,
        pi.medicine_name,
        COALESCE(pi.quantity, 1) AS required_quantity,
        COALESCE(pi.dispensed_quantity, 0) AS dispensed_quantity,
        pi.dosage,
        pi.frequency,
        pi.duration,
        pi.instructions,
        m.id AS medicine_id,
        m.avg_price
      FROM prescription_items pi
      LEFT JOIN medicines m
        ON LOWER(m.name) = LOWER(pi.medicine_name)
      WHERE pi.prescription_id = $1
        AND pi.id = ANY($2::int[])
    `,
    [prescriptionId, prescriptionItemIds]
  );

  return new Map(query.rows.map((row) => [Number(row.prescription_item_id), row]));
};

const getDemandCountsByMedicine = async (
  client: PoolClient,
  pharmacyId: unknown,
  medicineIds: number[]
) => {
  if (!medicineIds.length) return new Map<number, number>();
  try {
    const demandLogs = await getDemandLogsSchema(client);
    const whereParts = [`${quoteIdent(demandLogs.medicineCol)} = ANY($1::int[])`];
    const values: unknown[] = [medicineIds];
    if (demandLogs.pharmacyCol && pharmacyId) {
      values.push(pharmacyId);
      whereParts.push(`${quoteIdent(demandLogs.pharmacyCol)} = $${values.length}`);
    }

    const result = await client.query(
      `
        SELECT
          ${quoteIdent(demandLogs.medicineCol)} AS medicine_id,
          SUM(${quoteIdent(demandLogs.quantityCol)})::int AS demand_count
        FROM demand_logs
        WHERE ${whereParts.join(" AND ")}
        GROUP BY ${quoteIdent(demandLogs.medicineCol)}
      `,
      values
    );

    return new Map(
      result.rows.map((row) => [Number(row.medicine_id), Number(row.demand_count ?? 0)])
    );
  } catch {
    return new Map<number, number>();
  }
};

const getSubstitutionOptions = async (
  client: PoolClient,
  pharmacyId: unknown,
  medicineId: number | null,
  limit = 3
) => {
  if (!medicineId || !pharmacyId) return [];
  await ensureMedicineClinicalColumns(client);
  const inventory = await getInventorySchema(client);
  const result = await client.query(
    `
      WITH source_medicine AS (
        SELECT
          id,
          category_id,
          NULLIF(LOWER(TRIM(generic_name)), '') AS generic_name,
          NULLIF(LOWER(TRIM(active_ingredient)), '') AS active_ingredient,
          NULLIF(LOWER(TRIM(strength)), '') AS strength,
          NULLIF(LOWER(TRIM(dosage_form)), '') AS dosage_form
        FROM medicines
        WHERE id = $1
      ),
      candidates AS (
        SELECT
          alt.id,
          alt.name,
          ${inventory.priceCol ? `inv.${quoteIdent(inventory.priceCol)}` : "NULL"} AS unit_price,
          inv.${quoteIdent(inventory.stockCol)} AS stock,
          CASE
            WHEN source.generic_name IS NOT NULL
              AND NULLIF(LOWER(TRIM(alt.generic_name)), '') = source.generic_name
              AND (
                source.strength IS NULL
                OR NULLIF(LOWER(TRIM(alt.strength)), '') IS NULL
                OR NULLIF(LOWER(TRIM(alt.strength)), '') = source.strength
              )
              AND (
                source.dosage_form IS NULL
                OR NULLIF(LOWER(TRIM(alt.dosage_form)), '') IS NULL
                OR NULLIF(LOWER(TRIM(alt.dosage_form)), '') = source.dosage_form
              )
              THEN 1
            WHEN source.active_ingredient IS NOT NULL
              AND NULLIF(LOWER(TRIM(alt.active_ingredient)), '') = source.active_ingredient
              AND (
                source.strength IS NULL
                OR NULLIF(LOWER(TRIM(alt.strength)), '') IS NULL
                OR NULLIF(LOWER(TRIM(alt.strength)), '') = source.strength
              )
              THEN 2
            WHEN alt.category_id = source.category_id THEN 3
            ELSE 9
          END AS match_rank
        FROM source_medicine source
        JOIN medicines alt
          ON alt.id <> source.id
         AND (
           (
             source.generic_name IS NOT NULL
             AND NULLIF(LOWER(TRIM(alt.generic_name)), '') = source.generic_name
           )
           OR (
             source.active_ingredient IS NOT NULL
             AND NULLIF(LOWER(TRIM(alt.active_ingredient)), '') = source.active_ingredient
           )
           OR (
             source.category_id IS NOT NULL
             AND alt.category_id = source.category_id
           )
         )
        JOIN inventory inv
          ON inv.${quoteIdent(inventory.medicineCol)} = alt.id
         AND inv.${quoteIdent(inventory.pharmacyCol)} = $2
         AND COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0) > 0
      )
      SELECT
        id,
        name,
        stock,
        unit_price,
        CASE
          WHEN match_rank = 1 THEN 'generic'
          WHEN match_rank = 2 THEN 'ingredient'
          ELSE 'category'
        END AS match_type,
        CASE
          WHEN match_rank = 1 THEN 'Generic match'
          WHEN match_rank = 2 THEN 'Ingredient match'
          ELSE 'Same category - pharmacist review required'
        END AS match_label,
        (match_rank >= 3) AS requires_pharmacist_review
      FROM candidates
      ORDER BY match_rank ASC, COALESCE(stock, 0) DESC, name ASC
      LIMIT $3
    `,
    [medicineId, pharmacyId, limit]
  );

  return result.rows.map((row) => ({
    medicineId: Number(row.id),
    medicineName: row.name,
    availableStock: Number(row.stock ?? 0),
    unitPrice:
      row.unit_price === null || row.unit_price === undefined ? null : Number(row.unit_price),
    matchType: row.match_type,
    matchLabel: row.match_label,
    requiresPharmacistReview: Boolean(row.requires_pharmacist_review),
  }));
};

const recordDemandLogs = async (
  client: PoolClient,
  input: {
    pharmacyId: unknown;
    prescriptionId: unknown;
    source: string;
    items: Array<{ medicineId: number; quantity: number }>;
  }
) => {
  if (!input.items.length) return;
  try {
    const demandLogsSchema = await getDemandLogsSchema(client);
    for (const item of input.items) {
      const payload: Record<string, any> = {
        [demandLogsSchema.medicineCol]: item.medicineId,
        [demandLogsSchema.quantityCol]: item.quantity,
      };
      if (demandLogsSchema.pharmacyCol && input.pharmacyId) {
        payload[demandLogsSchema.pharmacyCol] = input.pharmacyId;
      }
      if (demandLogsSchema.prescriptionCol && input.prescriptionId) {
        payload[demandLogsSchema.prescriptionCol] = input.prescriptionId;
      }
      if (demandLogsSchema.sourceCol) {
        payload[demandLogsSchema.sourceCol] = input.source;
      }

      const insert = buildInsertParts(payload);
      await client.query(
        `
          INSERT INTO demand_logs (${insert.columns})
          VALUES (${insert.placeholders})
        `,
        insert.values
      );
    }
  } catch {
    // Demand logs are advisory; dispensing should not fail if analytics storage is unavailable.
  }
};

const getMedicineDetails = async (client: PoolClient, medicineIds: number[]) => {
  if (!medicineIds.length) return new Map<number, DbRecord>();
  const query = await client.query(
    `SELECT id, name, avg_price FROM medicines WHERE id = ANY($1::int[])`,
    [medicineIds]
  );
  return new Map(query.rows.map((row) => [Number(row.id), row]));
};

const getInventoryRows = async (client: PoolClient, pharmacyId: unknown, medicineIds: number[], lock = false) => {
  const inventory = await getInventorySchema(client);
  if (!medicineIds.length) {
    return { config: inventory, rows: new Map<number, DbRecord>() };
  }

  const query = await client.query(
    `
      SELECT
        ${quoteIdent(inventory.medicineCol)} AS medicine_id,
        ${quoteIdent(inventory.stockCol)} AS stock
        ${inventory.priceCol ? `, ${quoteIdent(inventory.priceCol)} AS unit_price` : ""}
      FROM inventory
      WHERE ${quoteIdent(inventory.pharmacyCol)} = $1
        AND ${quoteIdent(inventory.medicineCol)} = ANY($2::int[])
      ${lock ? "FOR UPDATE" : ""}
    `,
    [pharmacyId, medicineIds]
  );

  return {
    config: inventory,
    rows: new Map(query.rows.map((row) => [Number(row.medicine_id), row])),
  };
};

const getInventoryRowByMedicineId = async (
  client: PoolClient,
  pharmacyId: unknown,
  medicineId: number,
  lock = false
) => {
  const inventory = await getInventorySchema(client);
  const query = await client.query(
    `
      SELECT
        ${quoteIdent(inventory.medicineCol)} AS medicine_id,
        ${quoteIdent(inventory.stockCol)} AS stock
        ${inventory.priceCol ? `, ${quoteIdent(inventory.priceCol)} AS unit_price` : ""}
      FROM inventory
      WHERE ${quoteIdent(inventory.pharmacyCol)} = $1
        AND ${quoteIdent(inventory.medicineCol)} = $2
      ${lock ? "FOR UPDATE" : ""}
      LIMIT 1
    `,
    [pharmacyId, medicineId]
  );

  return {
    config: inventory,
    row: query.rows[0] ?? null,
  };
};

const mapMedicineInventoryRow = (row: DbRecord) => ({
  id: Number(row.id),
  name: row.name,
  category_id: row.category_id === null || row.category_id === undefined ? null : Number(row.category_id),
  category_name: row.category_name,
  brand_id: row.brand_id === null || row.brand_id === undefined ? null : Number(row.brand_id),
  brand_name: row.brand_name,
  description: row.description,
  image_url: row.image_url,
  generic_name: row.generic_name,
  active_ingredient: row.active_ingredient,
  strength: row.strength,
  dosage_form: row.dosage_form,
  quantity:
    row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
  price: row.price === null || row.price === undefined ? null : Number(row.price),
  expiry_date: row.expiry_date,
});

const fetchInventoryMedicineById = async (
  client: PoolClient,
  pharmacyId: unknown,
  medicineId: number
) => {
  const inventory = await getInventorySchema(client);
  const { rows } = await client.query(
    `
      SELECT
        m.id,
        m.name,
        m.category_id,
        c.name AS category_name,
        m.brand_id,
        b.name AS brand_name,
        m.description,
        m.image_url,
        m.generic_name,
        m.active_ingredient,
        m.strength,
        m.dosage_form,
        inv.${quoteIdent(inventory.stockCol)} AS quantity,
        ${inventory.priceCol ? `inv.${quoteIdent(inventory.priceCol)}` : "m.price"} AS price,
        m.expiry_date
      FROM inventory inv
      JOIN medicines m
        ON m.id = inv.${quoteIdent(inventory.medicineCol)}
      LEFT JOIN categories c ON c.id = m.category_id
      LEFT JOIN brands b ON b.id = m.brand_id
      WHERE inv.${quoteIdent(inventory.pharmacyCol)} = $1
        AND inv.${quoteIdent(inventory.medicineCol)} = $2
      LIMIT 1
    `,
    [pharmacyId, medicineId]
  );

  return rows[0] ? mapMedicineInventoryRow(rows[0]) : null;
};

const syncMarketplaceProductForInventoryMedicine = async (
  client: PoolClient,
  pharmacyId: number | string,
  medicine: ReturnType<typeof mapMedicineInventoryRow>
) => {
  const basePrice =
    medicine.price === null || medicine.price === undefined ? 0 : normalizeMoney(Number(medicine.price));

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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, FALSE, FALSE, TRUE, NOW(), NOW())
      ON CONFLICT (pharmacy_id, inventory_item_id)
      DO UPDATE
      SET
        name = EXCLUDED.name,
        generic_name = COALESCE(EXCLUDED.generic_name, marketplace_products.generic_name),
        brand = COALESCE(EXCLUDED.brand, marketplace_products.brand),
        description = COALESCE(EXCLUDED.description, marketplace_products.description),
        category = COALESCE(EXCLUDED.category, marketplace_products.category),
        price = CASE
          WHEN marketplace_products.price IS NULL OR marketplace_products.price <= 0
            THEN EXCLUDED.price
          ELSE marketplace_products.price
        END,
        image_url = COALESCE(EXCLUDED.image_url, marketplace_products.image_url),
        is_active = TRUE,
        updated_at = NOW()
    `,
    [
      pharmacyId,
      medicine.id,
      medicine.name,
      medicine.generic_name ?? null,
      medicine.brand_name ?? null,
      medicine.description ?? null,
      medicine.category_name ?? null,
      basePrice,
      medicine.image_url ?? null,
    ]
  );
};

const insertInventoryRecord = async (
  client: PoolClient,
  pharmacyId: unknown,
  medicineId: number,
  quantity: number,
  price: number
) => {
  const inventory = await getInventorySchema(client);
  const payload: Record<string, any> = {
    [inventory.pharmacyCol]: pharmacyId,
    [inventory.medicineCol]: medicineId,
    [inventory.stockCol]: quantity,
  };

  if (inventory.priceCol) {
    payload[inventory.priceCol] = price;
  }

  const insert = buildInsertParts(payload);
  await client.query(
    `
      INSERT INTO inventory (${insert.columns})
      VALUES (${insert.placeholders})
    `,
    insert.values
  );
};

export const fetchPharmacyProfileByUserId = async (userId: number) => {
  const result = await pool.query<{
    id: number;
    name: string;
    location: string | null;
    image_url: string | null;
    logo_url: string | null;
    cover_image_url: string | null;
  }>(
    `
    SELECT
      p.id,
      p.name,
      p.location,
      p.image_url,
      p.logo_url,
      p.cover_image_url
    FROM pharmacies p
    JOIN pharmacist_pharmacies pp
      ON pp.pharmacy_id = p.id
    WHERE pp.user_id = $1
    ORDER BY p.id ASC
    LIMIT 1
    `,
    [userId]
  );

  const pharmacy = result.rows[0];
  if (!pharmacy) {
    throw new HttpError(404, "Pharmacy not found");
  }

  return pharmacy;
};

export const fetchPrescriptionByQr = async (qrToken: string, pharmacyId: string | null) => {
  const client = await pool.connect();
  try {
    await ensurePrescriptionItemDispenseColumns(client);
  } finally {
    client.release();
  }

  const rowsQuery = await pool.query(
    `
      SELECT
        p.id AS prescription_id,
        p.qr_code,
        p.is_seen,
        p.issued_at,
        p.dispensed_at,
        p.dispensed_by,
        pu.name AS patient_name,
        du.name AS doctor_name,
        pi.id AS prescription_item_id,
        pi.medicine_name,
        COALESCE(pi.quantity, 1) AS required_quantity,
        COALESCE(pi.dispensed_quantity, 0) AS dispensed_quantity,
        pi.dosage,
        pi.frequency,
        pi.duration,
        pi.instructions,
        m.id AS medicine_id
      FROM prescriptions p
      LEFT JOIN consultations c
        ON c.id = p.consultation_id
      LEFT JOIN users pu
        ON pu.id = c.patient_id
      LEFT JOIN users du
        ON du.id = c.doctor_id
      LEFT JOIN prescription_items pi
        ON pi.prescription_id = p.id
      LEFT JOIN medicines m
        ON LOWER(m.name) = LOWER(pi.medicine_name)
      WHERE p.qr_code = $1
      ORDER BY pi.id ASC
    `,
    [qrToken]
  );

  if (!rowsQuery.rowCount) {
    throw new HttpError(404, "Prescription not found");
  }

  const rows = rowsQuery.rows;
  let inventoryRows = new Map<number, DbRecord>();

  if (pharmacyId) {
    const medicineIds = rows
      .map((row) => (row.medicine_id ? Number(row.medicine_id) : null))
      .filter((value): value is number => Number.isInteger(value));

    if (medicineIds.length) {
      const client = await pool.connect();
      try {
        inventoryRows = (await getInventoryRows(client, pharmacyId, medicineIds)).rows;
      } finally {
        client.release();
      }
    }
  }

  const prescription = rows[0];

  return {
    prescription: {
      id: prescription.prescription_id,
      qrCode: prescription.qr_code,
      token: prescription.qr_code,
      isSeen: prescription.is_seen,
      issuedAt: prescription.issued_at,
      dispensedAt: prescription.dispensed_at,
      dispensedBy: prescription.dispensed_by,
      patientName: prescription.patient_name,
      doctorName: prescription.doctor_name,
    },
    items: rows
      .filter((row) => row.prescription_item_id)
      .map((row) => {
        const inventory = row.medicine_id ? inventoryRows.get(Number(row.medicine_id)) : null;
        return {
          id: Number(row.prescription_item_id),
          medicineId: row.medicine_id ? Number(row.medicine_id) : null,
          medicineName: row.medicine_name,
          requiredQuantity: Number(row.required_quantity ?? 1),
          dispensedQuantity: Number(row.dispensed_quantity ?? 0),
          remainingQuantity: Math.max(
            0,
            Number(row.required_quantity ?? 1) - Number(row.dispensed_quantity ?? 0)
          ),
          dosage: row.dosage,
          frequency: row.frequency,
          duration: row.duration,
          instructions: row.instructions,
          availableStock: inventory ? Number(inventory.stock ?? 0) : null,
          unitPrice:
            inventory?.unit_price !== undefined && inventory?.unit_price !== null
              ? Number(inventory.unit_price)
              : null,
        };
      }),
  };
};

export const fetchPrescriptionById = async (prescriptionId: string, pharmacyId: string | null = null) => {
  const client = await pool.connect();
  try {
    await ensurePrescriptionItemDispenseColumns(client);
  } finally {
    client.release();
  }

  const prescriptionQuery = await pool.query(
    `
      SELECT
        p.id AS prescription_id,
        p.qr_code,
        p.status,
        p.is_seen,
        p.issued_at,
        p.dispensed_at,
        p.dispensed_by,
        patient_user.name AS patient_name,
        doctor_user.name AS doctor_name
      FROM prescriptions p
      LEFT JOIN consultations c ON c.id = p.consultation_id
      LEFT JOIN users patient_user ON patient_user.id = c.patient_id
      LEFT JOIN users doctor_user ON doctor_user.id = c.doctor_id
      WHERE p.id = $1
      LIMIT 1
    `,
    [prescriptionId]
  );

  if (!prescriptionQuery.rows.length) {
    throw new HttpError(404, "Prescription not found");
  }

  const itemsQuery = await pool.query(
    `
      SELECT
        pi.id AS prescription_item_id,
        COALESCE(pi.medicine_id, m.id) AS medicine_id,
        COALESCE(m.name, pi.medicine_name) AS medicine_name,
        COALESCE(pi.quantity, 1) AS required_quantity,
        COALESCE(pi.dispensed_quantity, 0) AS dispensed_quantity,
        pi.dosage,
        pi.frequency,
        pi.duration,
        pi.instructions,
        m.quantity AS current_stock
      FROM prescription_items pi
      LEFT JOIN medicines m
        ON m.id = pi.medicine_id
        OR (pi.medicine_id IS NULL AND pi.medicine_name IS NOT NULL AND LOWER(m.name) = LOWER(pi.medicine_name))
      WHERE pi.prescription_id = $1
      ORDER BY pi.id ASC
    `,
    [prescriptionId]
  );

  const prescription = prescriptionQuery.rows[0];
  let inventoryRows = new Map<number, DbRecord>();
  let demandCounts = new Map<number, number>();
  const substitutionOptions = new Map<number, Awaited<ReturnType<typeof getSubstitutionOptions>>>();

  if (pharmacyId) {
    const medicineIds = itemsQuery.rows
      .map((row) => (row.medicine_id === null || row.medicine_id === undefined ? null : Number(row.medicine_id)))
      .filter((value): value is number => Number.isInteger(value));

    if (medicineIds.length) {
      const client = await pool.connect();
      try {
        inventoryRows = (await getInventoryRows(client, pharmacyId, medicineIds)).rows;
        demandCounts = await getDemandCountsByMedicine(client, pharmacyId, medicineIds);
        for (const row of itemsQuery.rows) {
          const medicineId =
            row.medicine_id === null || row.medicine_id === undefined ? null : Number(row.medicine_id);
          const inventoryRow = medicineId ? inventoryRows.get(medicineId) : null;
          const currentStock = inventoryRow ? Number(inventoryRow.stock ?? 0) : Number(row.current_stock ?? 0);
          const remainingQuantity = Math.max(
            0,
            Number(row.required_quantity ?? 1) - Number(row.dispensed_quantity ?? 0)
          );
          if (medicineId && remainingQuantity > 0 && currentStock < remainingQuantity) {
            substitutionOptions.set(
              Number(row.prescription_item_id),
              await getSubstitutionOptions(client, pharmacyId, medicineId)
            );
          }
        }
      } finally {
        client.release();
      }
    }
  }

  return {
    prescription: {
      id: normalizeDbId(prescription.prescription_id),
      qrCode: prescription.qr_code,
      status: prescription.status,
      isSeen: prescription.is_seen,
      issuedAt: prescription.issued_at,
      dispensedAt: prescription.dispensed_at,
      dispensedBy: prescription.dispensed_by,
      patientName: prescription.patient_name,
      doctorName: prescription.doctor_name,
      token: prescription.qr_code,
    },
    items: itemsQuery.rows.map((row) => ({
      id: Number(row.prescription_item_id),
      medicineId: row.medicine_id === null || row.medicine_id === undefined ? null : Number(row.medicine_id),
      medicineName: row.medicine_name,
      dosage: row.dosage,
      frequency: row.frequency,
      duration: row.duration,
      instructions: row.instructions,
      requiredQuantity:
        row.required_quantity === null || row.required_quantity === undefined
          ? 1
          : Number(row.required_quantity),
      dispensedQuantity: Number(row.dispensed_quantity ?? 0),
      remainingQuantity: Math.max(
        0,
        Number(row.required_quantity ?? 1) - Number(row.dispensed_quantity ?? 0)
      ),
      currentStock:
        (() => {
          const inventoryRow =
            row.medicine_id === null || row.medicine_id === undefined
              ? null
              : inventoryRows.get(Number(row.medicine_id));
          if (inventoryRow) {
            return Number(inventoryRow.stock ?? 0);
          }
          return row.current_stock === null || row.current_stock === undefined
            ? 0
            : Number(row.current_stock);
        })(),
      demandCount:
        row.medicine_id === null || row.medicine_id === undefined
          ? 0
          : demandCounts.get(Number(row.medicine_id)) ?? 0,
      lowStockAlert:
        (() => {
          const medicineId =
            row.medicine_id === null || row.medicine_id === undefined ? null : Number(row.medicine_id);
          const demandCount = medicineId ? demandCounts.get(medicineId) ?? 0 : 0;
          const currentStock =
            row.medicine_id === null || row.medicine_id === undefined
              ? Number(row.current_stock ?? 0)
              : Number(inventoryRows.get(Number(row.medicine_id))?.stock ?? row.current_stock ?? 0);
          const remainingQuantity = Math.max(
            0,
            Number(row.required_quantity ?? 1) - Number(row.dispensed_quantity ?? 0)
          );
          return currentStock <= remainingQuantity || (demandCount >= 3 && currentStock <= 5);
        })(),
      substitutions: substitutionOptions.get(Number(row.prescription_item_id)) ?? [],
    })),
  };
};

export const fetchInventory = async (pharmacyId: number | string) => {
  const client = await pool.connect();
  try {
    await ensureMedicineClinicalColumns(client);
  } finally {
    client.release();
  }

  const rows = await withTransaction(async (txnClient) => {
    const inventorySchema = await getInventorySchema(txnClient);
    const result = await txnClient.query(
      `
        SELECT
          m.id,
          m.name,
          m.category_id,
          c.name AS category_name,
          m.brand_id,
          b.name AS brand_name,
          m.description,
          m.image_url,
          m.generic_name,
          m.active_ingredient,
          m.strength,
          m.dosage_form,
          inv.${quoteIdent(inventorySchema.stockCol)} AS quantity,
          ${inventorySchema.priceCol ? `inv.${quoteIdent(inventorySchema.priceCol)}` : "m.price"} AS price,
          m.expiry_date
        FROM inventory inv
        JOIN medicines m
          ON m.id = inv.${quoteIdent(inventorySchema.medicineCol)}
        LEFT JOIN categories c ON c.id = m.category_id
        LEFT JOIN brands b ON b.id = m.brand_id
        WHERE inv.${quoteIdent(inventorySchema.pharmacyCol)} = $1
        ORDER BY m.name ASC
      `,
      [pharmacyId]
    );

    return result.rows;
  });

  return {
    medicines: rows.map(mapMedicineInventoryRow),
  };
};

export const fetchCategories = async () => {
  const { rows } = await pool.query(
    `SELECT id, name FROM categories ORDER BY name ASC`
  );

  return {
    categories: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
    })),
  };
};

export const fetchBrands = async () => {
  const { rows } = await pool.query(
    `SELECT id, name FROM brands ORDER BY name ASC`
  );

  return {
    brands: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
    })),
  };
};

export const createCategory = async (input: CreateLookupInput) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO categories (name) VALUES ($1) RETURNING id, name`,
      [input.name]
    );

    return {
      message: "Category created successfully",
      category: {
        id: Number(rows[0].id),
        name: rows[0].name,
      },
    };
  } catch (error: any) {
    if (error?.code === "23505") {
      throw new HttpError(409, "Category already exists");
    }
    throw error;
  }
};

export const createBrand = async (input: CreateLookupInput) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO brands (name) VALUES ($1) RETURNING id, name`,
      [input.name]
    );

    return {
      message: "Brand created successfully",
      brand: {
        id: Number(rows[0].id),
        name: rows[0].name,
      },
    };
  } catch (error: any) {
    if (error?.code === "23505") {
      throw new HttpError(409, "Brand already exists");
    }
    throw error;
  }
};

export const createMedicine = async (input: CreateMedicineInput, pharmacyId: number | string) => {
  try {
    const medicine = await withTransaction(async (txnClient) => {
      await ensureMedicineClinicalColumns(txnClient);

      const existingMedicineQuery = await txnClient.query(
        `
          SELECT id
          FROM medicines
          WHERE LOWER(name) = LOWER($1)
          LIMIT 1
        `,
        [input.name]
      );

      let medicineId: number;

      if (existingMedicineQuery.rows.length) {
        medicineId = Number(existingMedicineQuery.rows[0].id);
      } else {
        const insertResult = await txnClient.query(
          `
            INSERT INTO medicines (
              name,
              category_id,
              brand_id,
              description,
              image_url,
              generic_name,
              active_ingredient,
              strength,
              dosage_form,
              quantity,
              expiry_date,
              price
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id
          `,
          [
            input.name,
            input.categoryId,
            input.brandId,
            input.description,
            input.imageUrl,
            input.genericName,
            input.activeIngredient,
            input.strength,
            input.dosageForm,
            input.quantity,
            input.expiryDate,
            input.price,
          ]
        );

        medicineId = Number(insertResult.rows[0].id);
      }

      const existingInventory = await getInventoryRowByMedicineId(txnClient, pharmacyId, medicineId, true);
      if (existingInventory.row) {
        throw new HttpError(409, "Medicine already exists in this pharmacy inventory");
      }

      await insertInventoryRecord(txnClient, pharmacyId, medicineId, input.quantity, input.price);
      const inventoryMedicine = await fetchInventoryMedicineById(txnClient, pharmacyId, medicineId);

      if (!inventoryMedicine) {
        throw new HttpError(500, "Medicine was created but inventory could not be loaded");
      }

      await syncMarketplaceProductForInventoryMedicine(txnClient, pharmacyId, inventoryMedicine);

      return inventoryMedicine;
    });

    return {
      message: "Medicine saved successfully",
      medicine,
    };
  } catch (error: any) {
    if (error?.code === "23503") {
      throw new HttpError(400, "Selected category or brand does not exist");
    }
    throw error;
  }
};

export const updateMedicine = async (input: UpdateMedicineInput, pharmacyId: number | string) => {
  const medicine = await withTransaction(async (txnClient) => {
    await ensureMedicineClinicalColumns(txnClient);

    const inventoryRow = await getInventoryRowByMedicineId(txnClient, pharmacyId, input.id, true);
    if (!inventoryRow.row) {
      throw new HttpError(404, "Medicine not found in this pharmacy inventory");
    }

    const medicineResult = await txnClient.query(
      `
        UPDATE medicines
        SET
          name = $1,
          category_id = $2,
          brand_id = $3,
          description = $4,
          image_url = $5,
          generic_name = $6,
          active_ingredient = $7,
          strength = $8,
          dosage_form = $9,
          quantity = $10,
          expiry_date = $11,
          price = $12
        WHERE id = $13
        RETURNING id
      `,
      [
        input.name,
        input.categoryId,
        input.brandId,
        input.description,
        input.imageUrl,
        input.genericName,
        input.activeIngredient,
        input.strength,
        input.dosageForm,
        input.quantity,
        input.expiryDate,
        input.price,
        input.id,
      ]
    );

    if (!medicineResult.rows.length) {
      throw new HttpError(404, "Medicine not found");
    }

    const updateAssignments = [`${quoteIdent(inventoryRow.config.stockCol)} = $1`];
    const updateValues: Array<number | string> = [input.quantity];

    if (inventoryRow.config.priceCol) {
      updateAssignments.push(`${quoteIdent(inventoryRow.config.priceCol)} = $2`);
      updateValues.push(input.price);
    }

    updateValues.push(pharmacyId, input.id);

    await txnClient.query(
      `
        UPDATE inventory
        SET ${updateAssignments.join(", ")}
        WHERE ${quoteIdent(inventoryRow.config.pharmacyCol)} = $${updateValues.length - 1}
          AND ${quoteIdent(inventoryRow.config.medicineCol)} = $${updateValues.length}
      `,
      updateValues
    );

    const inventoryMedicine = await fetchInventoryMedicineById(txnClient, pharmacyId, input.id);
    if (!inventoryMedicine) {
      throw new HttpError(500, "Updated medicine could not be loaded");
    }

    await syncMarketplaceProductForInventoryMedicine(txnClient, pharmacyId, inventoryMedicine);

    return inventoryMedicine;
  });

  return {
    message: "Medicine updated successfully",
    medicine,
  };
};

export const restockMedicine = async (input: RestockMedicineInput, pharmacyId: number | string) => {
  const medicine = await withTransaction(async (txnClient) => {
    const inventoryRow = await getInventoryRowByMedicineId(txnClient, pharmacyId, input.id, true);
    if (!inventoryRow.row) {
      throw new HttpError(404, "Medicine not found in this pharmacy inventory");
    }

    const updateResult = await txnClient.query(
      `
        UPDATE inventory
        SET ${quoteIdent(inventoryRow.config.stockCol)} = COALESCE(${quoteIdent(inventoryRow.config.stockCol)}, 0) + $1
        WHERE ${quoteIdent(inventoryRow.config.pharmacyCol)} = $2
          AND ${quoteIdent(inventoryRow.config.medicineCol)} = $3
      `,
      [input.quantity, pharmacyId, input.id]
    );

    if (!updateResult.rowCount) {
      throw new HttpError(404, "Medicine not found in this pharmacy inventory");
    }

    const inventoryMedicine = await fetchInventoryMedicineById(txnClient, pharmacyId, input.id);
    if (!inventoryMedicine) {
      throw new HttpError(500, "Restocked medicine could not be loaded");
    }

    await syncMarketplaceProductForInventoryMedicine(txnClient, pharmacyId, inventoryMedicine);

    return inventoryMedicine;
  });

  return {
    message: "Stock updated successfully",
    medicine,
  };
};

export const deleteMedicine = async (id: number, pharmacyId: number | string) => {
  await withTransaction(async (txnClient) => {
    const inventoryRow = await getInventoryRowByMedicineId(txnClient, pharmacyId, id, true);
    if (!inventoryRow.row) {
      throw new HttpError(404, "Medicine not found in this pharmacy inventory");
    }

    const deleteResult = await txnClient.query(
      `
        DELETE FROM inventory
        WHERE ${quoteIdent(inventoryRow.config.pharmacyCol)} = $1
          AND ${quoteIdent(inventoryRow.config.medicineCol)} = $2
      `,
      [pharmacyId, id]
    );

    if (!deleteResult.rowCount) {
      throw new HttpError(404, "Medicine not found in this pharmacy inventory");
    }
  });

  return { message: "Medicine deleted successfully", id };
};

export const dispensePrescription = async (input: {
  prescriptionId: unknown;
  pharmacyId: unknown;
  pharmacistUserId: unknown;
  selectedItems: SelectedItemInput[];
}) =>
  withTransaction(async (client) => {
    await ensurePrescriptionItemDispenseColumns(client);
    const prescriptionSchema = await getPrescriptionSchema(client);
    const prescriptionResult = await client.query(
      `
        SELECT id, status, dispensed_at
        FROM prescriptions
        WHERE id = $1
        FOR UPDATE
      `,
      [input.prescriptionId]
    );

    if (!prescriptionResult.rows.length) {
      throw new HttpError(404, "Prescription not found");
    }

    const prescriptionRow = prescriptionResult.rows[0];
    if (
      Boolean(prescriptionRow.dispensed_at) ||
      String(prescriptionRow.status || "").toLowerCase() === "completed"
    ) {
      throw new HttpError(409, "Prescription has already been fully dispensed");
    }

    const itemIds = input.selectedItems.map((item) => item.prescriptionItemId as number);
    const itemMap = await getPrescriptionItems(client, input.prescriptionId, itemIds);

    if (itemMap.size !== itemIds.length) {
      throw new HttpError(404, "Some selected prescription items were not found");
    }

    const medicineIds = Array.from(
      new Set(
        Array.from(itemMap.values())
          .map((row) => (row.medicine_id ? Number(row.medicine_id) : null))
          .filter((value): value is number => Number.isInteger(value))
      )
    );

    const inventory = await getInventoryRows(client, input.pharmacyId, medicineIds, true);
    const stockUsage = new Map<number, number>();
    const dispensedItems: DbRecord[] = [];

    for (const selected of input.selectedItems) {
      const row = itemMap.get(selected.prescriptionItemId as number);
      if (!row?.medicine_id) {
        throw new HttpError(409, `Medicine not mapped for prescription item ${selected.prescriptionItemId}`);
      }

      const medicineId = Number(row.medicine_id);
      const requiredQuantity = Number(row.required_quantity ?? 1);
      const alreadyDispensed = Number(row.dispensed_quantity ?? 0);
      const remainingForItem = Math.max(0, requiredQuantity - alreadyDispensed);

      if (remainingForItem <= 0) {
        throw new HttpError(409, `${row.medicine_name} has already been fully dispensed`);
      }

      if (selected.quantity > remainingForItem) {
        throw new HttpError(409, `Requested quantity exceeds the remaining amount for ${row.medicine_name}`, {
          prescription_item_id: selected.prescriptionItemId,
          remaining_quantity: remainingForItem,
          requested_quantity: selected.quantity,
        });
      }

      const inventoryRow = inventory.rows.get(medicineId);
      if (!inventoryRow) {
        throw new HttpError(409, `Inventory record missing for ${row.medicine_name}`);
      }

      const currentStock = Number(inventoryRow.stock ?? 0);
      const nextUsage = (stockUsage.get(medicineId) || 0) + selected.quantity;

      if (currentStock < nextUsage) {
        throw new HttpError(409, `Insufficient stock for ${row.medicine_name}`, {
          medicine_id: medicineId,
          available_stock: currentStock,
          requested_quantity: nextUsage,
        });
      }

      stockUsage.set(medicineId, nextUsage);
      dispensedItems.push({
        prescription_item_id: selected.prescriptionItemId,
        medicine_id: medicineId,
        medicine_name: row.medicine_name,
        quantity: selected.quantity,
        required_quantity: requiredQuantity,
        dispensed_quantity: alreadyDispensed + selected.quantity,
        remaining_quantity: remainingForItem - selected.quantity,
        remaining_stock: currentStock - nextUsage,
      });
    }

    for (const [medicineId, quantity] of stockUsage) {
      await client.query(
        `
          UPDATE inventory
          SET ${quoteIdent(inventory.config.stockCol)} = ${quoteIdent(inventory.config.stockCol)} - $3
          WHERE ${quoteIdent(inventory.config.pharmacyCol)} = $1
            AND ${quoteIdent(inventory.config.medicineCol)} = $2
            AND ${quoteIdent(inventory.config.stockCol)} >= $3
        `,
        [input.pharmacyId, medicineId, quantity]
      );
    }

    for (const item of dispensedItems) {
      await client.query(
        `
          UPDATE prescription_items
          SET dispensed_quantity = COALESCE(dispensed_quantity, 0) + $2
          WHERE id = $1
        `,
        [item.prescription_item_id, item.quantity]
      );
    }

    const remainingResult = await client.query(
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
      [input.prescriptionId]
    );

    const remainingItems = remainingResult.rows
      .map((row) => ({
        prescription_item_id: Number(row.prescription_item_id),
        medicine_id: row.medicine_id ? Number(row.medicine_id) : null,
        medicine_name: row.medicine_name,
        required_quantity: Number(row.required_quantity ?? 1),
        dispensed_quantity: Number(row.dispensed_quantity ?? 0),
        remaining_quantity: Math.max(
          0,
          Number(row.required_quantity ?? 1) - Number(row.dispensed_quantity ?? 0)
        ),
      }))
      .filter((row) => row.remaining_quantity > 0);

    const dispenseStatus = remainingItems.length ? "partially_dispensed" : "completed";

    await recordDemandLogs(client, {
      pharmacyId: input.pharmacyId,
      prescriptionId: input.prescriptionId,
      source: "partial_dispense_remainder",
      items: remainingItems
        .filter((item) => item.medicine_id)
        .map((item) => ({
          medicineId: item.medicine_id as number,
          quantity: item.remaining_quantity,
        })),
    });

    const updateFields = [`status = '${dispenseStatus}'`];
    const updateValues: any[] = [input.prescriptionId];

    if (dispenseStatus === "completed") {
      updateFields.push("dispensed_at = NOW()");
    }

    if (prescriptionSchema.dispensedByCol && input.pharmacistUserId) {
      updateValues.push(input.pharmacistUserId);
      updateFields.push(
        `${quoteIdent(prescriptionSchema.dispensedByCol)} = $${updateValues.length}`
      );
    }

    await client.query(
      `
        UPDATE prescriptions
        SET ${updateFields.join(", ")}
        WHERE id = $1
      `,
      updateValues
    );

    return {
      message:
        dispenseStatus === "completed"
          ? "Prescription dispensed successfully"
          : "Partial dispense recorded successfully",
      prescription_id: input.prescriptionId,
      dispense_status: dispenseStatus,
      is_partial: dispenseStatus !== "completed",
      dispensed_items: dispensedItems,
      remaining_items: remainingItems,
    };
  });

export const dispensePrescriptionById = async (input: {
  prescriptionId: string;
  pharmacistUserId?: unknown;
  pharmacyId: string | number;
}) =>
  withTransaction(async (client) => {
    await ensurePrescriptionItemDispenseColumns(client);
    const prescriptionSchema = await getPrescriptionSchema(client);
    const prescriptionResult = await client.query(
      `
        SELECT id, status, dispensed_at
        FROM prescriptions
        WHERE id = $1
        FOR UPDATE
      `,
      [input.prescriptionId]
    );

    if (!prescriptionResult.rows.length) {
      throw new HttpError(404, "Prescription not found");
    }

    const prescriptionRow = prescriptionResult.rows[0];
    if (
      (typeof prescriptionRow.status === "string" &&
        prescriptionRow.status.toLowerCase() === "completed") ||
      Boolean(prescriptionRow.dispensed_at)
    ) {
      throw new HttpError(409, "Prescription has already been dispensed");
    }

    const itemsResult = await client.query(
      `
        SELECT
          pi.id AS prescription_item_id,
          COALESCE(pi.medicine_id, m.id) AS medicine_id,
          COALESCE(pi.quantity, 1) AS required_quantity,
          COALESCE(pi.dispensed_quantity, 0) AS dispensed_quantity,
          COALESCE(m.name, pi.medicine_name) AS medicine_name
        FROM prescription_items pi
        LEFT JOIN medicines m
          ON m.id = pi.medicine_id
          OR (pi.medicine_id IS NULL AND pi.medicine_name IS NOT NULL AND LOWER(m.name) = LOWER(pi.medicine_name))
        WHERE pi.prescription_id = $1
        ORDER BY pi.id ASC
      `,
      [input.prescriptionId]
    );

    if (!itemsResult.rows.length) {
      throw new HttpError(404, "No prescription items found");
    }

    const requiredByMedicine = new Map<number, { medicineName: string; required: number; itemIds: number[] }>();

    for (const row of itemsResult.rows) {
      const medicineId = row.medicine_id ? Number(row.medicine_id) : null;
      const required = Math.max(
        0,
        Number(row.required_quantity ?? 1) - Number(row.dispensed_quantity ?? 0)
      );

      if (!medicineId) {
        throw new HttpError(409, `Medicine not mapped for prescription item ${row.prescription_item_id}`);
      }

      if (!Number.isFinite(required)) {
        throw new HttpError(409, `Invalid remaining quantity for prescription item ${row.prescription_item_id}`);
      }

      if (required <= 0) {
        continue;
      }

      const existing = requiredByMedicine.get(medicineId);
      if (existing) {
        existing.required += required;
        existing.itemIds.push(Number(row.prescription_item_id));
      } else {
        requiredByMedicine.set(medicineId, {
          medicineName: row.medicine_name ?? `Medicine #${medicineId}`,
          required,
          itemIds: [Number(row.prescription_item_id)],
        });
      }
    }

    if (!requiredByMedicine.size) {
      throw new HttpError(409, "Prescription has already been fully dispensed");
    }

    const medicineIds = Array.from(requiredByMedicine.keys());
    const inventory = await getInventoryRows(client, input.pharmacyId, medicineIds, true);

    const dispensedItems: DbRecord[] = [];

    for (const [medicineId, requiredInfo] of requiredByMedicine) {
      const inventoryRow = inventory.rows.get(medicineId);

      if (!inventoryRow) {
        throw new HttpError(409, `Inventory record missing for ${requiredInfo.medicineName}`);
      }

      const currentStock = Number(inventoryRow.stock ?? 0);

      if (currentStock < requiredInfo.required) {
        throw new HttpError(409, `Insufficient stock for ${requiredInfo.medicineName}`, {
          medicine_id: medicineId,
          available_quantity: currentStock,
          required_quantity: requiredInfo.required,
          prescription_item_ids: requiredInfo.itemIds,
        });
      }
    }

    for (const [medicineId, requiredInfo] of requiredByMedicine) {
      const updateResult = await client.query(
        `
          UPDATE inventory
          SET ${quoteIdent(inventory.config.stockCol)} = ${quoteIdent(inventory.config.stockCol)} - $3
          WHERE ${quoteIdent(inventory.config.pharmacyCol)} = $1
            AND ${quoteIdent(inventory.config.medicineCol)} = $2
            AND ${quoteIdent(inventory.config.stockCol)} >= $3
          RETURNING
            ${quoteIdent(inventory.config.medicineCol)} AS medicine_id,
            ${quoteIdent(inventory.config.stockCol)} AS quantity
        `,
        [input.pharmacyId, medicineId, requiredInfo.required]
      );

      if (!updateResult.rows.length) {
        throw new HttpError(409, `Failed to update quantity for ${requiredInfo.medicineName}`);
      }

      dispensedItems.push({
        medicine_id: medicineId,
        medicine_name: requiredInfo.medicineName,
        dispensed_quantity: requiredInfo.required,
        remaining_quantity: Number(updateResult.rows[0].quantity ?? 0),
        prescription_item_ids: requiredInfo.itemIds,
      });
    }

    for (const item of itemsResult.rows) {
      const medicineId = item.medicine_id ? Number(item.medicine_id) : null;
      const remaining = Math.max(
        0,
        Number(item.required_quantity ?? 1) - Number(item.dispensed_quantity ?? 0)
      );
      if (!medicineId || remaining <= 0) continue;
      await client.query(
        `
          UPDATE prescription_items
          SET dispensed_quantity = COALESCE(dispensed_quantity, 0) + $2
          WHERE id = $1
        `,
        [Number(item.prescription_item_id), remaining]
      );
    }

    const updateFields = ["status = 'completed'", "dispensed_at = NOW()"];
    const updateValues: any[] = [input.prescriptionId];

    if (prescriptionSchema.dispensedByCol && input.pharmacistUserId) {
      updateValues.push(input.pharmacistUserId);
      updateFields.push(
        `${quoteIdent(prescriptionSchema.dispensedByCol)} = $${updateValues.length}`
      );
    }

    await client.query(
      `
        UPDATE prescriptions
        SET ${updateFields.join(", ")}
        WHERE id = $1
      `,
      updateValues
    );

    return {
      message: "Prescription dispensed successfully",
      prescription_id: normalizeDbId(input.prescriptionId),
      status: "completed",
      dispensed_items: dispensedItems,
    };
  });

export const createSale = async (input: {
  pharmacyId: unknown;
  prescriptionId: unknown;
  pharmacistUserId: unknown;
  items: SelectedItemInput[];
}) =>
  withTransaction(async (client) => {
    const salesSchema = await getSalesSchema(client);
    const saleItemsSchema = await getSaleItemsSchema(client);
    const prescriptionItemIds = input.items
      .map((item) => item.prescriptionItemId)
      .filter((value): value is number => Number.isInteger(value as number));
    const itemMap = prescriptionItemIds.length
      ? await getPrescriptionItems(client, input.prescriptionId, prescriptionItemIds)
      : new Map<number, DbRecord>();
    const medicineIds = Array.from(
      new Set(
        input.items
          .map((item) => item.medicineId || itemMap.get(item.prescriptionItemId as number)?.medicine_id)
          .filter((value): value is number => Number.isInteger(Number(value)))
          .map(Number)
      )
    );
    const medicineMap = await getMedicineDetails(client, medicineIds);
    const inventory = await getInventoryRows(client, input.pharmacyId, medicineIds);

    const preparedItems = input.items.map((item) => {
      const mapped = item.prescriptionItemId ? itemMap.get(item.prescriptionItemId) : null;
      const medicineId = item.medicineId || (mapped?.medicine_id ? Number(mapped.medicine_id) : null);
      if (!medicineId) {
        throw new HttpError(400, "Each sale item must include medicine_id or prescription_item_id");
      }

      const medicine = medicineMap.get(medicineId);
      const inventoryRow = inventory.rows.get(medicineId);
      const unitPrice =
        item.unitPrice ??
        (inventoryRow?.unit_price !== undefined && inventoryRow?.unit_price !== null
          ? Number(inventoryRow.unit_price)
          : medicine?.avg_price !== undefined && medicine?.avg_price !== null
            ? Number(medicine.avg_price)
            : 0);

      return {
        medicine_id: medicineId,
        prescription_item_id: item.prescriptionItemId,
        medicine_name: mapped?.medicine_name || medicine?.name || null,
        quantity: item.quantity,
        unit_price: unitPrice,
        line_total: normalizeMoney(unitPrice * item.quantity),
      };
    });

    const totalAmount = normalizeMoney(
      preparedItems.reduce((sum, item) => sum + item.line_total, 0)
    );

    const salePayload: Record<string, any> = {
      [salesSchema.totalCol]: totalAmount,
    };
    if (salesSchema.pharmacyCol) salePayload[salesSchema.pharmacyCol] = input.pharmacyId;
    if (salesSchema.prescriptionCol && input.prescriptionId) {
      salePayload[salesSchema.prescriptionCol] = input.prescriptionId;
    }
    if (salesSchema.soldByCol && input.pharmacistUserId) {
      salePayload[salesSchema.soldByCol] = input.pharmacistUserId;
    }

    const saleInsert = buildInsertParts(salePayload);
    const saleResult = await client.query(
      `
        INSERT INTO sales (${saleInsert.columns})
        VALUES (${saleInsert.placeholders})
        RETURNING ${quoteIdent(salesSchema.idCol)} AS sale_id
      `,
      saleInsert.values
    );

    const saleId = saleResult.rows[0]?.sale_id;
    if (!saleId) {
      throw new HttpError(500, "Failed to create sale record");
    }

    for (const item of preparedItems) {
      const payload: Record<string, any> = {
        [saleItemsSchema.saleCol]: saleId,
        [saleItemsSchema.medicineCol]: item.medicine_id,
        [saleItemsSchema.quantityCol]: item.quantity,
        [saleItemsSchema.unitPriceCol]: item.unit_price,
      };
      if (saleItemsSchema.totalCol) payload[saleItemsSchema.totalCol] = item.line_total;
      if (saleItemsSchema.prescriptionItemCol && item.prescription_item_id) {
        payload[saleItemsSchema.prescriptionItemCol] = item.prescription_item_id;
      }

      const insert = buildInsertParts(payload);
      await client.query(
        `
          INSERT INTO sale_items (${insert.columns})
          VALUES (${insert.placeholders})
        `,
        insert.values
      );
    }

    return {
      message: "Sale created successfully",
      sale_id: saleId,
      total_amount: totalAmount,
      items: preparedItems,
    };
  });

export const createDemandLog = async (input: {
  pharmacyId: unknown;
  prescriptionId: unknown;
  source: string;
  items: DemandItemInput[];
}) =>
  withTransaction(async (client) => {
    const demandLogsSchema = await getDemandLogsSchema(client);

    for (const item of input.items) {
      const payload: Record<string, any> = {
        [demandLogsSchema.medicineCol]: item.medicineId,
        [demandLogsSchema.quantityCol]: item.quantity,
      };
      if (demandLogsSchema.pharmacyCol && input.pharmacyId) {
        payload[demandLogsSchema.pharmacyCol] = input.pharmacyId;
      }
      if (demandLogsSchema.prescriptionCol && input.prescriptionId) {
        payload[demandLogsSchema.prescriptionCol] = input.prescriptionId;
      }
      if (demandLogsSchema.sourceCol) payload[demandLogsSchema.sourceCol] = input.source;

      const insert = buildInsertParts(payload);
      await client.query(
        `
          INSERT INTO demand_logs (${insert.columns})
          VALUES (${insert.placeholders})
        `,
        insert.values
      );
    }

    return {
      message: "Demand log created successfully",
      items: input.items.map((item) => ({
        medicine_id: item.medicineId,
        quantity: item.quantity,
      })),
    };
  });
