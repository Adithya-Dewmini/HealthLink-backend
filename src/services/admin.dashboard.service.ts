import pool from "../config/db";
import { columnExists } from "./admin.schema.service";

type CountRow = { count: number };

export type AdminDashboardStats = {
  total_users: number;
  active_medical_centers: number;
  active_pharmacies: number;
  active_doctors: number;
  live_queues: number;
  active_sessions: number;
  today_bookings: number;
  today_prescriptions: number;
};

export type RecentAdminAction = {
  id: string;
  action: string;
  action_type: "approval" | "rejection" | "activation" | "deactivation" | "update";
  entity_type: string | null;
  entity_id: string | null;
  actor_name: string;
  actor_email: string | null;
  created_at: string;
  notes: Record<string, unknown> | null;
};

export type AdminDashboardResponse = {
  stats: AdminDashboardStats;
  recent_admin_actions: RecentAdminAction[];
};

export type AdminAlertsResponse = {
  pending_verifications: {
    clinics: number;
    doctors: number;
    pharmacies: number;
  };
  inactive_centers_with_users: number;
  doctors_pending_requests: number;
  pharmacy_alerts: {
    repeated_dispense_failures: number;
    low_stock_medicines: number;
    expiring_medicines: number;
  };
};

export type AdminActivitySummaryResponse = {
  queues_live_now: number;
  sessions_live_now: number;
  prescriptions_today: number;
  dispensations_today: number;
};

export type AdminIntelligenceResponse = {
  fulfillment_rate: number;
  cancellation_rate: number;
  total_prescription_orders: number;
  platform_growth_30d: {
    users: number;
    orders: number;
    prescriptions: number;
  };
  busiest_pharmacies: Array<{
    pharmacy_id: number;
    pharmacy_name: string;
    order_count: number;
    revenue: number;
  }>;
  queue_traffic: Array<{
    date: string;
    count: number;
  }>;
  medicine_demand: Array<{
    medicine_id: number;
    name: string;
    demand_count: number;
  }>;
};

const countValue = async (sql: string, params: unknown[] = []) => {
  const result = await pool.query<CountRow>(sql, params);
  return result.rows[0]?.count ?? 0;
};

const tableExists = async (tableName: string) => {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${tableName}`]
  );
  return Boolean(result.rows[0]?.exists);
};

const getExistingColumn = async (tableName: string, candidates: string[]) => {
  for (const candidate of candidates) {
    if (await columnExists(tableName, candidate)) {
      return candidate;
    }
  }

  return null;
};

const getRecentAdminActions = async (): Promise<RecentAdminAction[]> => {
  const result = await pool.query<{
    id: string;
    action: string;
    action_type: "approval" | "rejection" | "activation" | "deactivation" | "update";
    entity_type: string | null;
    entity_id: string | null;
    actor_name: string | null;
    actor_email: string | null;
    created_at: string;
    notes: Record<string, unknown> | null;
  }>(
    `
      SELECT
        al.id::text AS id,
        al.action,
        CASE
          WHEN LOWER(al.action) LIKE '%approve%' THEN 'approval'
          WHEN LOWER(al.action) LIKE '%reject%' THEN 'rejection'
          WHEN LOWER(al.action) LIKE '%deactivat%' OR LOWER(al.action) LIKE '%disable%' THEN 'deactivation'
          WHEN LOWER(al.action) LIKE '%activat%' OR LOWER(al.action) LIKE '%enable%' THEN 'activation'
          ELSE 'update'
        END AS action_type,
        al.entity_type,
        al.entity_id,
        actor.name AS actor_name,
        actor.email AS actor_email,
        al.created_at::text AS created_at,
        al.notes
      FROM audit_logs al
      LEFT JOIN users actor ON actor.id = COALESCE(al.actor_id, al.user_id)
      WHERE
        LOWER(al.action) LIKE '%approve%'
        OR LOWER(al.action) LIKE '%reject%'
        OR LOWER(al.action) LIKE '%activat%'
        OR LOWER(al.action) LIKE '%deactivat%'
        OR LOWER(al.action) LIKE '%enable%'
        OR LOWER(al.action) LIKE '%disable%'
      ORDER BY al.created_at DESC
      LIMIT 10
    `
  );

  return result.rows.map((row) => ({
    id: row.id,
    action: row.action,
    action_type: row.action_type,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    actor_name: row.actor_name || "System admin",
    actor_email: row.actor_email,
    created_at: row.created_at,
    notes: row.notes,
  }));
};

const getPharmacyAlerts = async () => {
  const [inventoryExists, demandLogsExists] = await Promise.all([
    tableExists("inventory"),
    tableExists("demand_logs"),
  ]);

  const lowStockMedicines = inventoryExists
    ? await countValue(
        `
          SELECT COUNT(*)::int AS count
          FROM inventory
          WHERE COALESCE(stock, stock_quantity, quantity, qty, 0) <= 5
        `
      ).catch(() =>
        countValue(`SELECT COUNT(*)::int AS count FROM medicines WHERE COALESCE(quantity, 0) <= 5`)
      )
    : await countValue(`SELECT COUNT(*)::int AS count FROM medicines WHERE COALESCE(quantity, 0) <= 5`);

  const expiringMedicines = await countValue(
    `
      SELECT COUNT(*)::int AS count
      FROM medicines
      WHERE expiry_date IS NOT NULL
        AND expiry_date <= CURRENT_DATE + INTERVAL '30 days'
    `
  );

  const repeatedDispenseFailures = demandLogsExists
    ? await countValue(
        `
          SELECT COUNT(*)::int AS count
          FROM (
            SELECT medicine_id
            FROM demand_logs
            WHERE LOWER(COALESCE(source, reason, event_type, '')) LIKE '%fail%'
               OR LOWER(COALESCE(source, reason, event_type, '')) LIKE '%insufficient%'
            GROUP BY medicine_id
            HAVING COUNT(*) >= 3
          ) flagged
        `
      ).catch(() => 0)
    : 0;

  return {
    repeated_dispense_failures: repeatedDispenseFailures,
    low_stock_medicines: lowStockMedicines,
    expiring_medicines: expiringMedicines,
  };
};

export const getAdminDashboardData = async (): Promise<AdminDashboardResponse> => {
  const [
    totalUsers,
    activeMedicalCenters,
    activePharmacies,
    activeDoctors,
    liveQueues,
    activeSessions,
    todayBookings,
    todayPrescriptions,
    recentAdminActions,
  ] = await Promise.all([
    countValue(`SELECT COUNT(*)::int AS count FROM users`),
    countValue(
      `
        SELECT COUNT(*)::int AS count
        FROM medical_centers
        WHERE COALESCE(is_active, TRUE) = TRUE
          AND UPPER(COALESCE(status, 'ACTIVE')) = 'ACTIVE'
      `
    ),
    countValue(
      `
        SELECT COUNT(*)::int AS count
        FROM pharmacies
        WHERE LOWER(COALESCE(status, 'active')) NOT IN ('inactive', 'disabled', 'closed')
      `
    ),
    countValue(
      `
        SELECT COUNT(DISTINCT doctor_id)::int AS count
        FROM (
          SELECT d.id AS doctor_id
          FROM doctors d
          WHERE d.medical_center_id IS NOT NULL
          UNION
          SELECT d.id AS doctor_id
          FROM doctors d
          JOIN medical_center_doctors mcd
            ON mcd.doctor_id = d.user_id
          WHERE mcd.status = 'ACTIVE'
        ) active_doctors
      `
    ),
    countValue(`SELECT COUNT(*)::int AS count FROM queues WHERE UPPER(COALESCE(status, '')) IN ('LIVE', 'PAUSED')`),
    countValue(
      `
        SELECT COUNT(*)::int AS count
        FROM medical_center_doctor_schedule
        WHERE COALESCE(is_active, TRUE) = TRUE
          AND UPPER(COALESCE(status, '')) = 'LIVE'
      `
    ),
    countValue(
      `
        SELECT COUNT(*)::int AS count
        FROM bookings
        WHERE date = CURRENT_DATE
          AND COALESCE(UPPER(status), '') <> 'CANCELLED'
      `
    ),
    countValue(
      `
        SELECT COUNT(*)::int AS count
        FROM prescriptions
        WHERE issued_at::date = CURRENT_DATE
      `
    ),
    getRecentAdminActions(),
  ]);

  return {
    stats: {
      total_users: totalUsers,
      active_medical_centers: activeMedicalCenters,
      active_pharmacies: activePharmacies,
      active_doctors: activeDoctors,
      live_queues: liveQueues,
      active_sessions: activeSessions,
      today_bookings: todayBookings,
      today_prescriptions: todayPrescriptions,
    },
    recent_admin_actions: recentAdminActions,
  };
};

export const getAdminAlerts = async (): Promise<AdminAlertsResponse> => {
  const [
    pendingClinics,
    pendingDoctors,
    pendingPharmacies,
    inactiveCentersWithUsers,
    doctorsPendingRequests,
    pharmacyAlerts,
  ] = await Promise.all([
    countValue(
      `SELECT COUNT(*)::int AS count FROM medical_centers WHERE LOWER(COALESCE(verification_status, 'pending')) = 'pending'`
    ),
    countValue(
      `SELECT COUNT(*)::int AS count FROM doctors WHERE LOWER(COALESCE(verification_status, 'pending')) = 'pending'`
    ),
    countValue(
      `SELECT COUNT(*)::int AS count FROM pharmacies WHERE LOWER(COALESCE(verification_status, 'pending')) = 'pending'`
    ),
    countValue(
      `
        SELECT COUNT(*)::int AS count
        FROM medical_centers mc
        WHERE COALESCE(mc.is_active, FALSE) = FALSE
          AND (
            mc.admin_id IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM medical_center_users mcu
              WHERE mcu.medical_center_id = mc.id
                AND UPPER(COALESCE(mcu.status, 'ACTIVE')) = 'ACTIVE'
            )
            OR EXISTS (
              SELECT 1
              FROM medical_center_doctors mcd
              WHERE mcd.medical_center_id = mc.id
                AND mcd.status = 'ACTIVE'
            )
            OR EXISTS (
              SELECT 1
              FROM receptionists r
              WHERE r.medical_center_id = mc.id
            )
          )
      `
    ),
    countValue(
      `
        SELECT COUNT(*)::int AS count
        FROM doctor_join_requests
        WHERE status = 'PENDING'
      `
    ),
    getPharmacyAlerts(),
  ]);

  return {
    pending_verifications: {
      clinics: pendingClinics,
      doctors: pendingDoctors,
      pharmacies: pendingPharmacies,
    },
    inactive_centers_with_users: inactiveCentersWithUsers,
    doctors_pending_requests: doctorsPendingRequests,
    pharmacy_alerts: pharmacyAlerts,
  };
};

export const getAdminActivitySummary = async (): Promise<AdminActivitySummaryResponse> => {
  const [queuesLiveNow, sessionsLiveNow, prescriptionsToday, dispensationsToday] = await Promise.all([
    countValue(`SELECT COUNT(*)::int AS count FROM queues WHERE UPPER(COALESCE(status, '')) IN ('LIVE', 'PAUSED')`),
    countValue(
      `
        SELECT COUNT(*)::int AS count
        FROM medical_center_doctor_schedule
        WHERE COALESCE(is_active, TRUE) = TRUE
          AND UPPER(COALESCE(status, '')) = 'LIVE'
      `
    ),
    countValue(`SELECT COUNT(*)::int AS count FROM prescriptions WHERE issued_at::date = CURRENT_DATE`),
    countValue(`SELECT COUNT(*)::int AS count FROM prescriptions WHERE dispensed_at::date = CURRENT_DATE`),
  ]);

  return {
    queues_live_now: queuesLiveNow,
    sessions_live_now: sessionsLiveNow,
    prescriptions_today: prescriptionsToday,
    dispensations_today: dispensationsToday,
  };
};

export const getAdminIntelligence = async (): Promise<AdminIntelligenceResponse> => {
  const [usersTimestampColumn, ordersTimestampColumn, queuePatientsTimestampColumn] = await Promise.all([
    getExistingColumn("users", ["created_at"]),
    getExistingColumn("orders", ["created_at", "updated_at", "delivered_at"]),
    getExistingColumn("queue_patients", ["created_at", "checked_in_at", "started_at", "completed_at"]),
  ]);

  const usersGrowthSql = usersTimestampColumn
    ? `(SELECT COUNT(*)::int FROM users WHERE ${usersTimestampColumn} >= NOW() - INTERVAL '30 days')`
    : `0`;
  const ordersGrowthSql = ordersTimestampColumn
    ? `(SELECT COUNT(*)::int FROM orders WHERE ${ordersTimestampColumn} >= NOW() - INTERVAL '30 days')`
    : `0`;
  const busiestPharmaciesJoinSql = ordersTimestampColumn
    ? `LEFT JOIN orders o
          ON o.pharmacy_id = p.id
         AND o.${ordersTimestampColumn} >= NOW() - INTERVAL '30 days'`
    : `LEFT JOIN orders o
          ON o.pharmacy_id = p.id`;
  const queueTrafficSql = queuePatientsTimestampColumn
    ? `
        SELECT
          ${queuePatientsTimestampColumn}::date AS bucket_date,
          COUNT(*)::int AS queue_count
        FROM queue_patients
        WHERE ${queuePatientsTimestampColumn} >= NOW() - INTERVAL '7 days'
        GROUP BY ${queuePatientsTimestampColumn}::date
        ORDER BY bucket_date ASC
      `
    : `
        SELECT
          NULL::date AS bucket_date,
          0::int AS queue_count
        WHERE FALSE
      `;

  const [orderMetrics, growthMetrics, busiestPharmacies, queueTraffic, medicineDemand] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE status IN ('completed', 'delivered'))::int AS completed_count,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
          COUNT(*)::int AS total_count,
          COUNT(*) FILTER (WHERE prescription_id IS NOT NULL)::int AS prescription_order_count
        FROM orders
      `
    ),
    pool.query(
      `
        SELECT
          ${usersGrowthSql} AS users_growth,
          ${ordersGrowthSql} AS orders_growth,
          (SELECT COUNT(*)::int FROM prescriptions WHERE issued_at >= NOW() - INTERVAL '30 days') AS prescriptions_growth
      `
    ),
    pool.query(
      `
        SELECT
          p.id AS pharmacy_id,
          p.name AS pharmacy_name,
          COUNT(o.id)::int AS order_count,
          COALESCE(SUM(o.total), 0)::numeric AS revenue
        FROM pharmacies p
        ${busiestPharmaciesJoinSql}
        GROUP BY p.id, p.name
        ORDER BY order_count DESC, revenue DESC
        LIMIT 5
      `
    ),
    pool.query(queueTrafficSql),
    pool.query(
      `
        SELECT
          oi.inventory_item_id AS medicine_id,
          COALESCE(m.name, mp.name, 'Medicine') AS name,
          SUM(oi.quantity)::int AS demand_count
        FROM order_items oi
        LEFT JOIN medicines m ON m.id = oi.inventory_item_id
        LEFT JOIN marketplace_products mp ON mp.id = oi.marketplace_product_id
        GROUP BY oi.inventory_item_id, COALESCE(m.name, mp.name, 'Medicine')
        ORDER BY demand_count DESC
        LIMIT 8
      `
    ),
  ]);

  const metrics = orderMetrics.rows[0] ?? {};
  const totalCount = Number(metrics.total_count ?? 0);
  const completedCount = Number(metrics.completed_count ?? 0);
  const cancelledCount = Number(metrics.cancelled_count ?? 0);
  const growth = growthMetrics.rows[0] ?? {};

  return {
    fulfillment_rate: totalCount > 0 ? Number(((completedCount / totalCount) * 100).toFixed(2)) : 0,
    cancellation_rate: totalCount > 0 ? Number(((cancelledCount / totalCount) * 100).toFixed(2)) : 0,
    total_prescription_orders: Number(metrics.prescription_order_count ?? 0),
    platform_growth_30d: {
      users: Number(growth.users_growth ?? 0),
      orders: Number(growth.orders_growth ?? 0),
      prescriptions: Number(growth.prescriptions_growth ?? 0),
    },
    busiest_pharmacies: busiestPharmacies.rows.map((row) => ({
      pharmacy_id: Number(row.pharmacy_id ?? 0),
      pharmacy_name: String(row.pharmacy_name ?? "Pharmacy"),
      order_count: Number(row.order_count ?? 0),
      revenue: Number(Number(row.revenue ?? 0).toFixed(2)),
    })),
    queue_traffic: queueTraffic.rows.map((row) => ({
      date: new Date(row.bucket_date).toISOString(),
      count: Number(row.queue_count ?? 0),
    })),
    medicine_demand: medicineDemand.rows.map((row) => ({
      medicine_id: Number(row.medicine_id ?? 0),
      name: String(row.name ?? "Medicine"),
      demand_count: Number(row.demand_count ?? 0),
    })),
  };
};
