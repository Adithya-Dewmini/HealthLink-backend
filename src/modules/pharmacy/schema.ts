import type { PoolClient } from "pg";
import { HttpError } from "./errors";

const tableColumnCache = new Map<string, Set<string>>();

export const quoteIdent = (value: string) => `"${value.replace(/"/g, "\"\"")}"`;

const readColumns = async (client: PoolClient, tableName: string) => {
  const cached = tableColumnCache.get(tableName);
  if (cached) return cached;

  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
    `,
    [tableName]
  );

  if (!result.rowCount) {
    throw new HttpError(500, `Required table "${tableName}" does not exist`);
  }

  const columns = new Set(result.rows.map((row) => String(row.column_name)));
  tableColumnCache.set(tableName, columns);
  return columns;
};

const pickColumn = (columns: Set<string>, candidates: string[]) =>
  candidates.find((candidate) => columns.has(candidate)) || null;

const requireColumn = (columns: Set<string>, candidates: string[], label: string) => {
  const column = pickColumn(columns, candidates);
  if (!column) {
    throw new HttpError(500, `Missing required column for ${label}`, {
      checked: candidates,
    });
  }
  return column;
};

export const getInventorySchema = async (client: PoolClient) => {
  const columns = await readColumns(client, "inventory");
  return {
    pharmacyCol: requireColumn(columns, ["pharmacy_id"], "inventory pharmacy"),
    medicineCol: requireColumn(columns, ["medicine_id"], "inventory medicine"),
    stockCol: requireColumn(columns, ["stock", "stock_quantity", "quantity", "qty"], "inventory stock"),
    priceCol: pickColumn(columns, ["unit_price", "selling_price", "price", "avg_price"]),
  };
};

export const getSalesSchema = async (client: PoolClient) => {
  const columns = await readColumns(client, "sales");
  return {
    idCol: requireColumn(columns, ["id"], "sales id"),
    pharmacyCol: pickColumn(columns, ["pharmacy_id"]),
    prescriptionCol: pickColumn(columns, ["prescription_id"]),
    totalCol: requireColumn(columns, ["total_amount", "total", "grand_total"], "sales total"),
    soldByCol: pickColumn(columns, ["sold_by", "pharmacist_id", "created_by"]),
  };
};

export const getSaleItemsSchema = async (client: PoolClient) => {
  const columns = await readColumns(client, "sale_items");
  return {
    saleCol: requireColumn(columns, ["sale_id"], "sale_items sale"),
    medicineCol: requireColumn(columns, ["medicine_id"], "sale_items medicine"),
    quantityCol: requireColumn(columns, ["quantity", "qty"], "sale_items quantity"),
    unitPriceCol: requireColumn(columns, ["unit_price", "price"], "sale_items unit price"),
    totalCol: pickColumn(columns, ["line_total", "total", "subtotal"]),
    prescriptionItemCol: pickColumn(columns, ["prescription_item_id"]),
  };
};

export const getDemandLogsSchema = async (client: PoolClient) => {
  const columns = await readColumns(client, "demand_logs");
  return {
    pharmacyCol: pickColumn(columns, ["pharmacy_id"]),
    medicineCol: requireColumn(columns, ["medicine_id"], "demand_logs medicine"),
    quantityCol: requireColumn(columns, ["quantity", "qty"], "demand_logs quantity"),
    prescriptionCol: pickColumn(columns, ["prescription_id"]),
    sourceCol: pickColumn(columns, ["source", "reason", "event_type"]),
  };
};

export const getPrescriptionSchema = async (client: PoolClient) => {
  const columns = await readColumns(client, "prescriptions");
  return {
    dispensedByCol: pickColumn(columns, ["dispensed_by"]),
  };
};
