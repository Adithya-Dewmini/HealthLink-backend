import axios from "axios";
import pool from "../../config/db";
import { env } from "../../config/env";
import { getInventorySchema, quoteIdent } from "../pharmacy/schema";
import type { PharmacyAnalyticsDashboard } from "./types";

const normalizeMoney = (value: unknown) => Number(Number(value ?? 0).toFixed(2));
const FORECAST_CACHE_TTL_MS = 1000 * 60 * 15;
const forecastCache = new Map<
  string,
  { expiresAt: number; value: PharmacyAnalyticsDashboard["forecastHighlights"] }
>();

const getCachedForecastHighlights = (pharmacyId: number | string) => {
  const key = String(pharmacyId);
  const cached = forecastCache.get(key);
  if (!cached || cached.expiresAt < Date.now()) {
    forecastCache.delete(key);
    return null;
  }
  return cached.value;
};

const setCachedForecastHighlights = (
  pharmacyId: number | string,
  value: PharmacyAnalyticsDashboard["forecastHighlights"]
) => {
  forecastCache.set(String(pharmacyId), {
    value,
    expiresAt: Date.now() + FORECAST_CACHE_TTL_MS,
  });
};

export const getPharmacyAnalyticsDashboard = async (
  pharmacyId: number | string
): Promise<PharmacyAnalyticsDashboard> => {
  const client = await pool.connect();
  try {
    const inventory = await getInventorySchema(client);

    const [ordersResult, trendResult, topMedicinesResult, lowStockResult] = await Promise.all([
      client.query(
        `
          SELECT
            COUNT(*)::int AS total_orders,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_orders,
            COUNT(*) FILTER (
              WHERE status IN (
                'pending',
                'confirmed',
                'preparing',
                'partially_ready',
                'awaiting_substitution_approval',
                'ready_for_pickup'
              )
            )::int AS pending_orders,
            COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_orders,
            COALESCE(SUM(total) FILTER (WHERE status IN ('completed', 'ready_for_pickup')), 0)::numeric AS total_revenue,
            COUNT(*) FILTER (WHERE prescription_id IS NOT NULL)::int AS prescription_volume
          FROM orders
          WHERE pharmacy_id = $1
        `,
        [pharmacyId]
      ),
      client.query(
        `
          SELECT
            created_at::date AS bucket_date,
            COUNT(*)::int AS order_count,
            COALESCE(SUM(total), 0)::numeric AS revenue
          FROM orders
          WHERE pharmacy_id = $1
            AND created_at >= NOW() - INTERVAL '30 days'
          GROUP BY created_at::date
          ORDER BY bucket_date ASC
        `,
        [pharmacyId]
      ),
      client.query(
        `
          SELECT
            oi.inventory_item_id AS medicine_id,
            mp.name,
            SUM(oi.quantity)::int AS quantity_sold,
            COALESCE(SUM(oi.total_price), 0)::numeric AS revenue
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          JOIN marketplace_products mp ON mp.id = oi.marketplace_product_id
          WHERE o.pharmacy_id = $1
            AND o.status IN ('completed', 'ready_for_pickup')
          GROUP BY oi.inventory_item_id, mp.name
          ORDER BY quantity_sold DESC, revenue DESC
          LIMIT 5
        `,
        [pharmacyId]
      ),
      client.query(
        `
          SELECT
            m.id AS medicine_id,
            m.name,
            COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0)::int AS quantity,
            ${
              inventory.reservedCol
                ? `COALESCE(inv.${quoteIdent(inventory.reservedCol)}, 0)::int`
                : "0::int"
            } AS reserved_quantity,
            GREATEST(
              COALESCE(inv.${quoteIdent(inventory.stockCol)}, 0) - ${
                inventory.reservedCol
                  ? `COALESCE(inv.${quoteIdent(inventory.reservedCol)}, 0)`
                  : "0"
              },
              0
            )::int AS available_stock
          FROM inventory inv
          JOIN medicines m ON m.id = inv.${quoteIdent(inventory.medicineCol)}
          WHERE inv.${quoteIdent(inventory.pharmacyCol)} = $1
          ORDER BY available_stock ASC, m.name ASC
          LIMIT 8
        `,
        [pharmacyId]
      ),
    ]);

    const orderRow = ordersResult.rows[0] ?? {};
    const totalOrders = Number(orderRow.total_orders ?? 0);
    const completedOrders = Number(orderRow.completed_orders ?? 0);
    const cancelledOrders = Number(orderRow.cancelled_orders ?? 0);

    let forecastHighlights: PharmacyAnalyticsDashboard["forecastHighlights"] = [];
    if (env.forecastServiceUrl) {
      const cachedForecast = getCachedForecastHighlights(pharmacyId);
      if (cachedForecast) {
        forecastHighlights = cachedForecast;
      } else {
        try {
          const forecastResponse = await axios.post(
            `${env.forecastServiceUrl.replace(/\/$/, "")}/forecast/predict`,
            {
              pharmacyId: Number(pharmacyId),
            },
            { timeout: 10000 }
          );
          forecastHighlights = Array.isArray(forecastResponse.data?.forecast)
            ? forecastResponse.data.forecast.slice(0, 5).map((item: any) => ({
                medicineId: Number(item.medicineId ?? item.medicine_id ?? 0),
                name: String(item.name ?? item.medicineName ?? "Medicine"),
                predictedDemand: Number(item.predictedDemand ?? item.predicted_demand ?? 0),
                recommendedReorderQuantity: Number(
                  item.recommendedReorderQuantity ?? item.recommended_reorder_quantity ?? 0
                ),
                shortageRisk:
                  item.shortageRisk === "high" || item.shortage_risk === "high"
                    ? "high"
                    : item.shortageRisk === "medium" || item.shortage_risk === "medium"
                      ? "medium"
                      : "low",
              }))
            : [];
          setCachedForecastHighlights(pharmacyId, forecastHighlights);
        } catch (error) {
          console.log("Forecast service unavailable:", error);
        }
      }
    }

    return {
      overview: {
        totalOrders,
        completedOrders,
        pendingOrders: Number(orderRow.pending_orders ?? 0),
        cancelledOrders,
        totalRevenue: normalizeMoney(orderRow.total_revenue),
        fulfillmentSuccessRate:
          totalOrders > 0 ? Number(((completedOrders / totalOrders) * 100).toFixed(2)) : 0,
        cancellationRate:
          totalOrders > 0 ? Number(((cancelledOrders / totalOrders) * 100).toFixed(2)) : 0,
        prescriptionVolume: Number(orderRow.prescription_volume ?? 0),
      },
      topMedicines: topMedicinesResult.rows.map((row) => ({
        medicineId: Number(row.medicine_id),
        name: row.name,
        quantitySold: Number(row.quantity_sold ?? 0),
        revenue: normalizeMoney(row.revenue),
      })),
      lowStockMedicines: lowStockResult.rows.map((row) => ({
        medicineId: Number(row.medicine_id),
        name: row.name,
        quantity: Number(row.quantity ?? 0),
        reservedQuantity: Number(row.reserved_quantity ?? 0),
        availableStock: Number(row.available_stock ?? 0),
      })),
      orderTrends: trendResult.rows.map((row) => ({
        date: new Date(row.bucket_date).toISOString(),
        orderCount: Number(row.order_count ?? 0),
        revenue: normalizeMoney(row.revenue),
      })),
      forecastHighlights,
    };
  } finally {
    client.release();
  }
};

export const getForecastForMedicine = async (
  pharmacyId: number | string,
  medicineId: number | string
) => {
  if (!env.forecastServiceUrl) {
    const error = new Error("Forecast service is not configured") as Error & { statusCode?: number };
    error.statusCode = 503;
    throw error;
  }

  const response = await axios.get(
    `${env.forecastServiceUrl.replace(/\/$/, "")}/forecast/medicine/${encodeURIComponent(
      String(medicineId)
    )}`,
    {
      params: {
        pharmacy_id: Number(pharmacyId),
      },
      timeout: 10000,
    }
  );

  return response.data;
};
