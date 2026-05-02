import pool from "../../config/db.ts";
import type { PoolClient } from "pg";
import { HttpError } from "./errors.ts";
import {
  getDemandLogsSchema,
  getInventorySchema,
  getPrescriptionSchema,
  getSaleItemsSchema,
  getSalesSchema,
  quoteIdent,
} from "./schema.ts";
import type {
  CreateLookupInput,
  CreateMedicineInput,
  DemandItemInput,
  RestockMedicineInput,
  SelectedItemInput,
  UpdateMedicineInput,
} from "./validation.ts";

type DbRecord = Record<string, any>;

const normalizeMoney = (value: number) => Number(value.toFixed(2));
const normalizeDbId = (value: unknown) =>
  typeof value === "number" ? value : String(value ?? "");

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
  const query = await client.query(
    `
      SELECT
        pi.id AS prescription_item_id,
        pi.medicine_name,
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

export const fetchPrescriptionByQr = async (qrToken: string, pharmacyId: string | null) => {
  const rowsQuery = await pool.query(
    `
      SELECT
        p.id AS prescription_id,
        p.qr_code,
        p.is_seen,
        p.issued_at,
        p.dispensed_at,
        p.dispensed_by,
        pi.id AS prescription_item_id,
        pi.medicine_name,
        pi.dosage,
        pi.frequency,
        pi.duration,
        pi.instructions,
        m.id AS medicine_id
      FROM prescriptions p
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
      isSeen: prescription.is_seen,
      issuedAt: prescription.issued_at,
      dispensedAt: prescription.dispensed_at,
      dispensedBy: prescription.dispensed_by,
    },
    items: rows
      .filter((row) => row.prescription_item_id)
      .map((row) => {
        const inventory = row.medicine_id ? inventoryRows.get(Number(row.medicine_id)) : null;
        return {
          id: Number(row.prescription_item_id),
          medicineId: row.medicine_id ? Number(row.medicine_id) : null,
          medicineName: row.medicine_name,
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

export const fetchPrescriptionById = async (prescriptionId: string) => {
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
      currentStock:
        row.current_stock === null || row.current_stock === undefined
          ? 0
          : Number(row.current_stock),
    })),
  };
};

export const fetchInventory = async () => {
  const { rows } = await pool.query(
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
        m.quantity,
        m.price,
        m.expiry_date
      FROM medicines m
      LEFT JOIN categories c ON c.id = m.category_id
      LEFT JOIN brands b ON b.id = m.brand_id
      ORDER BY name ASC
    `
  );

  return {
    medicines: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      category_id: row.category_id === null || row.category_id === undefined ? null : Number(row.category_id),
      category_name: row.category_name,
      brand_id: row.brand_id === null || row.brand_id === undefined ? null : Number(row.brand_id),
      brand_name: row.brand_name,
      description: row.description,
      image_url: row.image_url,
      quantity:
        row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
      price: row.price === null || row.price === undefined ? null : Number(row.price),
      expiry_date: row.expiry_date,
    })),
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

export const createMedicine = async (input: CreateMedicineInput) => {
  try {
    console.log("Create medicine insert values:", {
      name: input.name,
      categoryId: input.categoryId,
      brandId: input.brandId,
      description: input.description,
      imageUrl: input.imageUrl,
      quantity: input.quantity,
      expiryDate: input.expiryDate,
      price: input.price,
    });
    const { rows } = await pool.query(
      `
        INSERT INTO medicines (name, category_id, brand_id, description, image_url, quantity, expiry_date, price)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, name, category_id, brand_id, description, image_url, quantity, expiry_date, price, avg_price, created_at
      `,
      [
        input.name,
        input.categoryId,
        input.brandId,
        input.description,
        input.imageUrl,
        input.quantity,
        input.expiryDate,
        input.price,
      ]
    );

    return {
      message: "Medicine saved successfully",
      medicine: rows[0],
    };
  } catch (error: any) {
    if (error?.code === "23505") {
      throw new HttpError(409, "Medicine with this name already exists");
    }
    if (error?.code === "23503") {
      throw new HttpError(400, "Selected category or brand does not exist");
    }
    throw error;
  }
};

export const updateMedicine = async (input: UpdateMedicineInput) => {
  const { rows } = await pool.query(
    `
      UPDATE medicines
      SET
        name = $1,
        category_id = $2,
        brand_id = $3,
        description = $4,
        image_url = $5,
        quantity = $6,
        expiry_date = $7,
        price = $8
      WHERE id = $9
      RETURNING id, name, category_id, brand_id, description, image_url, quantity, expiry_date, price, avg_price, created_at
    `,
    [
      input.name,
      input.categoryId,
      input.brandId,
      input.description,
      input.imageUrl,
      input.quantity,
      input.expiryDate,
      input.price,
      input.id,
    ]
  );

  if (!rows.length) {
    throw new HttpError(404, "Medicine not found");
  }

  return {
    message: "Medicine updated successfully",
    medicine: rows[0],
  };
};

export const restockMedicine = async (input: RestockMedicineInput) => {
  const { rows } = await pool.query(
    `
      UPDATE medicines
      SET quantity = COALESCE(quantity, 0) + $1
      WHERE id = $2
      RETURNING id, name, category_id, brand_id, description, image_url, quantity, expiry_date, price, avg_price, created_at
    `,
    [input.quantity, input.id]
  );

  if (!rows.length) {
    throw new HttpError(404, "Medicine not found");
  }

  return {
    message: "Stock updated successfully",
    medicine: rows[0],
  };
};

export const deleteMedicine = async (id: number) => {
  const { rowCount } = await pool.query(`DELETE FROM medicines WHERE id = $1`, [id]);

  if (!rowCount) {
    throw new HttpError(404, "Medicine not found");
  }

  return { message: "Medicine deleted successfully", id };
};

export const dispensePrescription = async (input: {
  prescriptionId: unknown;
  pharmacyId: unknown;
  pharmacistUserId: unknown;
  selectedItems: SelectedItemInput[];
}) =>
  withTransaction(async (client) => {
    const prescriptionSchema = await getPrescriptionSchema(client);
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

    const updateFields = ["dispensed_at = NOW()"];
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
      prescription_id: input.prescriptionId,
      dispensed_items: dispensedItems,
    };
  });

export const dispensePrescriptionById = async (input: {
  prescriptionId: string;
  pharmacistUserId?: unknown;
}) =>
  withTransaction(async (client) => {
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
      typeof prescriptionRow.status === "string" &&
      prescriptionRow.status.toLowerCase() === "completed"
    ) {
      throw new HttpError(409, "Prescription has already been dispensed");
    }

    const itemsResult = await client.query(
      `
        SELECT
          pi.id AS prescription_item_id,
          COALESCE(pi.medicine_id, m.id) AS medicine_id,
          COALESCE(pi.quantity, 1) AS required_quantity,
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
      const required = Number(row.required_quantity ?? 1);

      if (!medicineId) {
        throw new HttpError(409, `Medicine not mapped for prescription item ${row.prescription_item_id}`);
      }

      if (!Number.isFinite(required) || required <= 0) {
        throw new HttpError(409, `Invalid required quantity for prescription item ${row.prescription_item_id}`);
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

    const medicineIds = Array.from(requiredByMedicine.keys());
    const medicineResult = await client.query(
      `
        SELECT id, name, quantity
        FROM medicines
        WHERE id = ANY($1::int[])
        FOR UPDATE
      `,
      [medicineIds]
    );

    const medicineMap = new Map(
      medicineResult.rows.map((row) => [
        Number(row.id),
        {
          id: Number(row.id),
          name: row.name,
          quantity: row.quantity === null || row.quantity === undefined ? 0 : Number(row.quantity),
        },
      ])
    );

    const dispensedItems: DbRecord[] = [];

    for (const [medicineId, requiredInfo] of requiredByMedicine) {
      const medicine = medicineMap.get(medicineId);

      if (!medicine) {
        throw new HttpError(404, `Medicine ${requiredInfo.medicineName} not found`);
      }

      if (medicine.quantity < requiredInfo.required) {
        throw new HttpError(409, `Insufficient stock for ${requiredInfo.medicineName}`, {
          medicine_id: medicineId,
          available_quantity: medicine.quantity,
          required_quantity: requiredInfo.required,
          prescription_item_ids: requiredInfo.itemIds,
        });
      }
    }

    for (const [medicineId, requiredInfo] of requiredByMedicine) {
      const medicine = medicineMap.get(medicineId)!;

      const updateResult = await client.query(
        `
          UPDATE medicines
          SET quantity = quantity - $1
          WHERE id = $2
            AND quantity >= $1
          RETURNING id, name, quantity
        `,
        [requiredInfo.required, medicineId]
      );

      if (!updateResult.rows.length) {
        throw new HttpError(409, `Failed to update quantity for ${requiredInfo.medicineName}`);
      }

      dispensedItems.push({
        medicine_id: medicineId,
        medicine_name: medicine.name,
        dispensed_quantity: requiredInfo.required,
        remaining_quantity: Number(updateResult.rows[0].quantity ?? 0),
        prescription_item_ids: requiredInfo.itemIds,
      });
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
