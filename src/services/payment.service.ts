import crypto from "crypto";
import type { PoolClient } from "pg";
import pool from "../config/db";
import { env } from "../config/env";
import { HttpError } from "../modules/pharmacy/errors";
import type { InvoiceSummary, PaymentStatus } from "../modules/orders/types";

type DbRecord = Record<string, any>;

type GatewayOrderRecord = {
  id: number;
  patient_id: number;
  pharmacy_id: number;
  status: string;
  total: number;
  subtotal: number;
  discount_total: number;
  currency: string;
  payment_method: string | null;
  payment_status: string | null;
  paid_at: string | null;
  prescription_id: string | null;
  fulfillment_type: string;
  invoice_id: number | null;
  order_code: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
  patient_name: string | null;
  patient_email: string | null;
  patient_phone: string | null;
  patient_address: string | null;
  patient_city: string | null;
  pharmacy_name: string;
  pharmacy_phone: string | null;
  pharmacy_email: string | null;
  pharmacy_location: string | null;
};

export type PaymentAccessContext = {
  userId: number;
  role: string;
};

export type CheckoutSession = {
  orderId: number;
  paymentId: number;
  gateway: "payhere";
  checkoutUrl: string;
  hostedUrl: string;
  hostedToken: string;
  gatewayOrderId: string;
  sandbox: boolean;
  mode: "sandbox" | "live";
  fields: PayHereCheckoutFields;
};

export type HostedCheckoutDocument = {
  html: string;
  formFields: Pick<
    PayHereCheckoutFields,
    | "merchant_id"
    | "return_url"
    | "cancel_url"
    | "notify_url"
    | "order_id"
    | "items"
    | "currency"
    | "amount"
    | "first_name"
    | "last_name"
    | "email"
    | "phone"
    | "address"
    | "city"
    | "country"
    | "hash"
  >;
};

export type PayHereCheckoutFields = {
  merchant_id: string;
  return_url: string;
  cancel_url: string;
  notify_url: string;
  order_id: string;
  items: string;
  currency: string;
  amount: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  custom_1: string;
  custom_2: string;
  hash: string;
};

export type PaymentStatusSummary = {
  orderId: number;
  orderStatus: string;
  paymentMethod: string | null;
  paymentStatus: PaymentStatus | null;
  paidAt: string | null;
  amount: number;
  currency: string;
  gatewayPaymentId: string | null;
  invoiceId: number | null;
  invoiceNo: string | null;
  updatedAt: string | null;
  message: string;
  payment: {
    id: number;
    gateway: string;
    gatewayPaymentId: string | null;
    gatewayOrderId: string | null;
    amount: number;
    currency: string;
    status: PaymentStatus;
    method: string | null;
    cardNoMasked: string | null;
    statusMessage: string | null;
    verifiedAt: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  invoice: InvoiceSummary | null;
};

export type InvoiceDetails = {
  invoice: InvoiceSummary;
  order: {
    id: number;
    orderCode: string | null;
    status: string;
    fulfillmentType: string;
    notes: string | null;
    paymentMethod: string | null;
    paymentStatus: string | null;
    paidAt: string | null;
    createdAt: string | null;
  };
  payment: {
    id: number | null;
    gateway: string | null;
    gatewayPaymentId: string | null;
    gatewayOrderId: string | null;
    amount: number;
    currency: string;
    status: string | null;
    method: string | null;
    cardNoMasked: string | null;
    verifiedAt: string | null;
  } | null;
  pharmacy: {
    id: number;
    name: string;
    phone: string | null;
    email: string | null;
    address: string | null;
  };
  patient: {
    id: number;
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  items: Array<{
    id: number;
    name: string;
    quantity: number;
    requestedQuantity: number;
    approvedQuantity: number;
    unitPrice: number;
    totalPrice: number;
    status: string;
    note: string | null;
  }>;
};

export type NotificationUpdateResult = {
  processed: boolean;
  ignoredReason?: string;
  orderId?: number;
  patientId?: number;
  pharmacyId?: number;
  paymentId?: number;
  paymentStatus?: PaymentStatus;
  invoiceId?: number | null;
  invoiceNo?: string | null;
};

const normalizeMoney = (value: unknown) => Number(Number(value ?? 0).toFixed(2));

const formatGatewayAmount = (value: number) => normalizeMoney(value).toFixed(2);

const PAYHERE_CHECKOUT_URLS = {
  sandbox: "https://sandbox.payhere.lk/pay/checkout",
  live: "https://www.payhere.lk/pay/checkout",
} as const;

const INVALID_GATEWAY_CONFIG_MESSAGE = "Payment gateway is not configured correctly.";

const PAYHERE_PLACEHOLDER_VALUES = [
  "your_sandbox_merchant_id",
  "your_sandbox_merchant_secret",
  "your-backend-name.onrender.com",
  "your-backend-url.com",
] as const;

const PAYHERE_DEBUG_LOGS_ENABLED =
  process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" && process.env.VITEST !== "true";

const getHostedCheckoutBaseUrl = () => {
  if (env.publicAppUrl) {
    return env.publicAppUrl;
  }

  if (env.appWebUrl) {
    return env.appWebUrl;
  }

  if (env.payHereNotifyUrl) {
    try {
      return new URL(env.payHereNotifyUrl).origin;
    } catch {
      // Fall through to the app-level fallbacks.
    }
  }
  return null;
};

const escapeHtmlAttribute = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const isPlaceholderConfigValue = (value: string) =>
  PAYHERE_PLACEHOLDER_VALUES.some((placeholder) => value.toLowerCase().includes(placeholder.toLowerCase()));

const normalizeHttpsUrl = (value: string) => {
  const trimmed = String(value || "").trim();
  if (!trimmed || isPlaceholderConfigValue(trimmed)) {
    throw new HttpError(503, INVALID_GATEWAY_CONFIG_MESSAGE);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(503, INVALID_GATEWAY_CONFIG_MESSAGE);
  }

  if (parsed.protocol !== "https:") {
    throw new HttpError(503, INVALID_GATEWAY_CONFIG_MESSAGE);
  }

  if (!parsed.hostname.trim()) {
    throw new HttpError(503, INVALID_GATEWAY_CONFIG_MESSAGE);
  }

  return parsed.toString();
};

const logPayHereCheckoutPayload = (fields: PayHereCheckoutFields) => {
  if (!PAYHERE_DEBUG_LOGS_ENABLED) {
    return;
  }

  console.info("[payments] PayHere checkout payload", {
    merchant_id: fields.merchant_id,
    order_id: fields.order_id,
    amount: fields.amount,
    currency: fields.currency,
    return_url: fields.return_url,
    cancel_url: fields.cancel_url,
    notify_url: fields.notify_url,
    items: fields.items,
    hashLength: fields.hash.length,
  });
};

const validateHostedCheckoutFields = (
  fields: PayHereCheckoutFields,
  merchantSecret: string
) => {
  const processMerchantId = String(process.env.PAYHERE_MERCHANT_ID || "").trim();
  const normalizedMerchantSecret = String(merchantSecret || "").trim();
  const expectedReturnUrl = String(process.env.PAYHERE_RETURN_URL || env.payHereReturnUrl || "").trim();
  const expectedCancelUrl = String(process.env.PAYHERE_CANCEL_URL || env.payHereCancelUrl || "").trim();
  const expectedNotifyUrl = String(process.env.PAYHERE_NOTIFY_URL || env.payHereNotifyUrl || "").trim();
  const hash = String(fields.hash || "");
  const issues: string[] = [];

  if (!String(fields.merchant_id || "").trim()) {
    issues.push("merchant_id is empty");
  }
  if (!processMerchantId || fields.merchant_id !== processMerchantId) {
    issues.push("merchant_id does not match process.env.PAYHERE_MERCHANT_ID");
  }
  if (!normalizedMerchantSecret) {
    issues.push("merchant secret is empty");
  }
  if (!/^\d+\.\d{2}$/.test(fields.amount)) {
    issues.push("amount format is invalid");
  }
  if (fields.currency !== "LKR") {
    issues.push("currency must be LKR");
  }
  if (!expectedReturnUrl || fields.return_url !== expectedReturnUrl) {
    issues.push("return_url must match PAYHERE_RETURN_URL");
  }
  if (!expectedCancelUrl || fields.cancel_url !== expectedCancelUrl) {
    issues.push("cancel_url must match PAYHERE_CANCEL_URL");
  }
  if (!expectedNotifyUrl || fields.notify_url !== expectedNotifyUrl) {
    issues.push("notify_url must match PAYHERE_NOTIFY_URL");
  }
  if (isPlaceholderConfigValue(fields.return_url) || isPlaceholderConfigValue(fields.cancel_url) || isPlaceholderConfigValue(fields.notify_url)) {
    issues.push("placeholder URL detected");
  }
  if (hash.length !== 32) {
    issues.push("hash length must be 32");
  }

  return {
    isValid: issues.length === 0,
    issues,
    merchantSecretLength: normalizedMerchantSecret.length,
    hashLength: hash.length,
  };
};

const logHostedCheckoutRenderPayload = (
  fields: PayHereCheckoutFields,
  merchantSecret: string
) => {
  const normalizedHash = String(fields.hash || "");
  const normalizedMerchantSecret = String(merchantSecret || "").trim();

  console.log({
    source: "PAYHERE_HOSTED_FORM_DEBUG",
    merchant_id: fields.merchant_id,
    order_id: fields.order_id,
    amount: fields.amount,
    currency: fields.currency,
    return_url: fields.return_url,
    cancel_url: fields.cancel_url,
    notify_url: fields.notify_url,
    items: fields.items,
    first_name: fields.first_name,
    last_name: fields.last_name,
    email: fields.email,
    phone: fields.phone,
    hashLength: normalizedHash.length,
    hashStart: normalizedHash.slice(0, 4),
    hashEnd: normalizedHash.slice(-4),
    merchantSecretLength: normalizedMerchantSecret.length,
  });
};

const buildHostedCheckoutValidationErrorHtml = (issues: string[]) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Payment configuration error</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
      .card { background:#ffffff; border:1px solid #dbe7f0; border-radius:20px; padding:32px; max-width:560px; box-shadow:0 30px 80px -50px rgba(15,23,42,.45); }
      h1 { margin-top:0; }
      ul { margin:16px 0 0; padding-left:20px; color:#475569; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Payment gateway is not configured correctly.</h1>
      <p>HealthLink could not open PayHere because the hosted payment form failed validation.</p>
      <ul>${issues.map((issue) => `<li>${escapeHtmlAttribute(issue)}</li>`).join("")}</ul>
    </div>
  </body>
</html>`;

const getPaymentGatewayConfig = () => {
  const mode = env.paymentGatewayMode === "live" ? ("live" as const) : ("sandbox" as const);
  const merchantId = String(env.payHereMerchantId || "").trim();
  const merchantSecret = String(env.payHereMerchantSecret || "").trim();

  if (!merchantId || !merchantSecret || isPlaceholderConfigValue(merchantId) || isPlaceholderConfigValue(merchantSecret)) {
    throw new HttpError(503, INVALID_GATEWAY_CONFIG_MESSAGE);
  }

  const checkoutUrl = PAYHERE_CHECKOUT_URLS[mode];
  if (env.payHereBaseUrl && String(env.payHereBaseUrl).trim() !== checkoutUrl) {
    throw new HttpError(503, INVALID_GATEWAY_CONFIG_MESSAGE);
  }

  return {
    merchantId,
    merchantSecret,
    checkoutUrl,
    returnUrl: normalizeHttpsUrl(String(env.payHereReturnUrl || "")),
    cancelUrl: normalizeHttpsUrl(String(env.payHereCancelUrl || "")),
    notifyUrl: normalizeHttpsUrl(String(env.payHereNotifyUrl || "")),
    mode,
  };
};

const buildPaymentStatusMessage = (input: {
  paymentMethod: string | null;
  paymentStatus: PaymentStatus | null;
  invoiceNo?: string | null;
}) => {
  if (input.paymentMethod !== "online") {
    return "Cash payment will be completed with the pharmacy.";
  }

  if (input.paymentStatus === "paid") {
    return input.invoiceNo
      ? `Payment successful. Invoice ${input.invoiceNo} is ready.`
      : "Payment successful.";
  }

  if (input.paymentStatus === "failed") {
    return "Payment failed. You can start a new checkout attempt.";
  }

  if (input.paymentStatus === "cancelled") {
    return "Payment cancelled.";
  }

  if (input.paymentStatus === "refunded") {
    return "Payment refunded.";
  }

  return "Payment confirmation is still pending.";
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

const mapPayHereStatusCode = (statusCode: string): PaymentStatus => {
  if (statusCode === "2") return "paid";
  if (statusCode === "0") return "pending";
  if (statusCode === "-1") return "cancelled";
  if (statusCode === "-3") return "refunded";
  return "failed";
};

export const generatePayHereHash = (
  merchantId: string,
  orderId: string,
  amount: number | string,
  currency: string,
  merchantSecret: string
) => {
  const normalizedMerchantId = String(merchantId || "").trim();
  const normalizedOrderId = String(orderId || "").trim();
  const normalizedAmount = formatGatewayAmount(Number(amount));
  const normalizedCurrency = String(currency || "LKR").trim().toUpperCase() || "LKR";
  const normalizedMerchantSecret = String(merchantSecret || "").trim();
  const secretMd5 = crypto.createHash("md5").update(normalizedMerchantSecret).digest("hex").toUpperCase();
  return crypto
    .createHash("md5")
    .update(`${normalizedMerchantId}${normalizedOrderId}${normalizedAmount}${normalizedCurrency}${secretMd5}`)
    .digest("hex")
    .toUpperCase();
};

const buildPayHereMd5Sig = (
  merchantId: string,
  orderId: string,
  amount: string,
  currency: string,
  statusCode: string,
  merchantSecret: string
) => {
  const normalizedMerchantId = String(merchantId || "").trim();
  const normalizedOrderId = String(orderId || "").trim();
  const normalizedAmount = formatGatewayAmount(Number(amount));
  const normalizedCurrency = String(currency || "LKR").trim().toUpperCase() || "LKR";
  const normalizedStatusCode = String(statusCode || "").trim();
  const normalizedMerchantSecret = String(merchantSecret || "").trim();
  const secretMd5 = crypto.createHash("md5").update(normalizedMerchantSecret).digest("hex").toUpperCase();
  return crypto
    .createHash("md5")
    .update(`${normalizedMerchantId}${normalizedOrderId}${normalizedAmount}${normalizedCurrency}${normalizedStatusCode}${secretMd5}`)
    .digest("hex")
    .toUpperCase();
};

const buildHostedCheckoutToken = (paymentId: number, orderId: number) => {
  const expiresAt = Date.now() + 1000 * 60 * 20;
  const payload = `${paymentId}.${orderId}.${expiresAt}`;
  const signature = crypto
    .createHmac("sha256", env.jwtSecret)
    .update(payload)
    .digest("hex");
  return `${payload}.${signature}`;
};

const verifyHostedCheckoutToken = (token: string, paymentId: number, orderId: number) => {
  const parts = token.split(".");
  if (parts.length !== 4) {
    throw new HttpError(400, "Invalid hosted checkout token");
  }

  const [rawPaymentId, rawOrderId, rawExpiry, providedSignature] = parts;
  if (Number(rawPaymentId) !== paymentId || Number(rawOrderId) !== orderId) {
    throw new HttpError(403, "Hosted checkout token does not match this payment");
  }

  const expiresAt = Number(rawExpiry);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    throw new HttpError(403, "Hosted checkout token expired");
  }

  const payload = `${rawPaymentId}.${rawOrderId}.${rawExpiry}`;
  const expectedSignature = crypto
    .createHmac("sha256", env.jwtSecret)
    .update(payload)
    .digest("hex");

  if (expectedSignature !== providedSignature) {
    throw new HttpError(403, "Hosted checkout token is invalid");
  }
};

const splitPatientName = (fullName: string | null | undefined) => {
  const normalized = String(fullName || "").trim();
  if (!normalized) {
    return { firstName: "HealthLink", lastName: "Patient" };
  }
  const parts = normalized.split(/\s+/);
  return {
    firstName: parts[0] || "HealthLink",
    lastName: parts.slice(1).join(" ") || "Patient",
  };
};

const buildPayHereCheckoutFields = (
  gatewayConfig: ReturnType<typeof getPaymentGatewayConfig>,
  order: GatewayOrderRecord,
  payment: {
    id: number;
    gatewayOrderId: string;
    amount: number;
    currency: string;
  }
): PayHereCheckoutFields => {
  const { firstName, lastName } = splitPatientName(order.patient_name);
  const amount = formatGatewayAmount(payment.amount);
  const currency = "LKR";
  const hash = generatePayHereHash(
    gatewayConfig.merchantId,
    payment.gatewayOrderId,
    amount,
    currency,
    gatewayConfig.merchantSecret
  );

  return {
    merchant_id: gatewayConfig.merchantId,
    return_url: gatewayConfig.returnUrl,
    cancel_url: gatewayConfig.cancelUrl,
    notify_url: gatewayConfig.notifyUrl,
    order_id: payment.gatewayOrderId,
    items: `${order.pharmacy_name} order #${order.id}`,
    currency,
    amount,
    first_name: firstName,
    last_name: lastName,
    email: order.patient_email || "",
    phone: order.patient_phone || "",
    address: order.patient_address || order.pharmacy_location || "",
    city: order.patient_city || "Colombo",
    country: "Sri Lanka",
    custom_1: String(order.id),
    custom_2: String(payment.id),
    hash,
  };
};

const getGatewayOrderRecord = async (client: PoolClient, orderId: number) => {
  const result = await client.query<GatewayOrderRecord>(
    `
      SELECT
        o.id,
        o.patient_id,
        o.pharmacy_id,
        o.status,
        o.total,
        o.subtotal,
        o.discount_total,
        COALESCE(o.currency, 'LKR') AS currency,
        o.payment_method,
        o.payment_status,
        o.paid_at,
        o.prescription_id,
        o.fulfillment_type,
        o.invoice_id,
        o.order_code,
        o.notes,
        o.created_at,
        o.updated_at,
        u.name AS patient_name,
        u.email AS patient_email,
        pp.phone AS patient_phone,
        pp.address AS patient_address,
        pp.city AS patient_city,
        p.name AS pharmacy_name,
        p.phone AS pharmacy_phone,
        p.email AS pharmacy_email,
        p.location AS pharmacy_location
      FROM orders o
      JOIN users u ON u.id = o.patient_id
      LEFT JOIN patient_profiles pp ON pp.user_id = u.id
      JOIN pharmacies p ON p.id = o.pharmacy_id
      WHERE o.id = $1
      LIMIT 1
      FOR UPDATE OF o
    `,
    [orderId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new HttpError(404, "Order not found");
  }

  return row;
};

const loadLatestPaymentRow = async (client: PoolClient, orderId: number) => {
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
  return result.rows[0] ?? null;
};

const loadInvoiceSummary = async (client: PoolClient, orderId: number): Promise<InvoiceSummary | null> => {
  const result = await client.query(
    `
      SELECT *
      FROM invoices
      WHERE order_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [orderId]
  );
  const row = result.rows[0];
  if (!row) return null;
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

const getPostPaymentOrderStatus = async (client: PoolClient, orderId: number) => {
  const result = await client.query(
    `
      SELECT COUNT(*) FILTER (
        WHERE COALESCE(approved_quantity, quantity, 0) < COALESCE(requested_quantity, quantity, 0)
           OR status IN ('partial', 'unavailable', 'partially_ready')
      )::int AS partial_items
      FROM order_items
      WHERE order_id = $1
    `,
    [orderId]
  );

  const partialItems = Number(result.rows[0]?.partial_items ?? 0);
  return partialItems > 0 ? "partially_ready" : "confirmed";
};

export const createInvoiceForPaidOrder = async (orderId: number) =>
  withTransaction(async (client) => createInvoiceForPaidOrderTx(client, orderId));

const createInvoiceForPaidOrderTx = async (client: PoolClient, orderId: number) => {
  const existing = await loadInvoiceSummary(client, orderId);
  if (existing) {
    return existing;
  }

  const order = await getGatewayOrderRecord(client, orderId);
  const paymentRow = await loadLatestPaymentRow(client, orderId);
  if (!paymentRow || String(paymentRow.status || "").toLowerCase() !== "paid") {
    throw new HttpError(409, "Invoice can only be created for paid orders");
  }

  const dateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.appTz,
  }).format(new Date()).replace(/-/g, "");

  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [dateKey]);
  const countResult = await client.query(
    `
      SELECT COUNT(*)::int AS invoice_count
      FROM invoices
      WHERE invoice_no LIKE $1
    `,
    [`HL-INV-${dateKey}-%`]
  );
  const invoiceNo = `HL-INV-${dateKey}-${String(Number(countResult.rows[0]?.invoice_count ?? 0) + 1).padStart(6, "0")}`;

  const insertResult = await client.query(
    `
      INSERT INTO invoices (
        invoice_no,
        order_id,
        payment_id,
        patient_id,
        pharmacy_id,
        subtotal,
        delivery_fee,
        service_fee,
        discount,
        total,
        currency,
        issued_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7, $8, $9, NOW(), NOW(), NOW())
      RETURNING *
    `,
    [
      invoiceNo,
      order.id,
      Number(paymentRow.id),
      order.patient_id,
      order.pharmacy_id,
      normalizeMoney(order.subtotal),
      normalizeMoney(order.discount_total),
      normalizeMoney(order.total),
      order.currency || "LKR",
    ]
  );

  await client.query(
    `
      UPDATE orders
      SET invoice_id = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [order.id, Number(insertResult.rows[0]?.id)]
  );

  return {
    id: Number(insertResult.rows[0].id),
    invoiceNo: insertResult.rows[0].invoice_no,
    subtotal: normalizeMoney(insertResult.rows[0].subtotal),
    deliveryFee: normalizeMoney(insertResult.rows[0].delivery_fee),
    serviceFee: normalizeMoney(insertResult.rows[0].service_fee),
    discount: normalizeMoney(insertResult.rows[0].discount),
    total: normalizeMoney(insertResult.rows[0].total),
    currency: insertResult.rows[0].currency ?? "LKR",
    pdfUrl: insertResult.rows[0].pdf_url ?? null,
    issuedAt: new Date(insertResult.rows[0].issued_at).toISOString(),
    createdAt: new Date(insertResult.rows[0].created_at).toISOString(),
    updatedAt: new Date(insertResult.rows[0].updated_at).toISOString(),
  };
};

export const createCheckoutSession = async (
  orderId: number,
  patientId: number
): Promise<CheckoutSession> =>
  withTransaction(async (client) => {
    const gatewayConfig = getPaymentGatewayConfig();
    const hostedBaseUrl = getHostedCheckoutBaseUrl();
    if (!hostedBaseUrl) {
      throw new HttpError(503, "Payment gateway is not configured");
    }

    const order = await getGatewayOrderRecord(client, orderId);
    if (Number(order.patient_id) !== patientId) {
      throw new HttpError(403, "You do not have access to this order");
    }

    const orderStatus = String(order.status || "").toLowerCase();
    if (["cancelled", "rejected", "completed", "delivered"].includes(orderStatus)) {
      throw new HttpError(409, "This order is no longer payable");
    }
    if (String(order.payment_status || "").toLowerCase() === "paid" || order.paid_at) {
      throw new HttpError(409, "This order has already been paid");
    }
    if (normalizeMoney(order.total) <= 0) {
      throw new HttpError(409, "This order is not payable");
    }

    const orderCurrency = String(order.currency || "LKR").toUpperCase();
    if (orderCurrency !== "LKR") {
      throw new HttpError(409, "This order is not payable");
    }

    const pendingPaymentsResult = await client.query(
      `
        SELECT id, gateway_order_id, amount, currency
        FROM payments
        WHERE order_id = $1
          AND status = 'pending'
        ORDER BY created_at DESC, id DESC
        FOR UPDATE
      `,
      [orderId]
    );

    const [activePendingPayment, ...stalePendingPayments] = pendingPaymentsResult.rows;
    if (stalePendingPayments.length) {
      await client.query(
        `
          UPDATE payments
          SET status = 'cancelled',
              status_message = COALESCE(status_message, 'Superseded by a newer checkout session'),
              updated_at = NOW()
          WHERE id = ANY($1::bigint[])
        `,
        [stalePendingPayments.map((payment) => Number(payment.id))]
      );
    }

    let paymentId = activePendingPayment ? Number(activePendingPayment.id) : 0;
    const gatewayOrderId = String(orderId);

    if (!paymentId) {
      const paymentResult = await client.query(
        `
          INSERT INTO payments (
            order_id,
            patient_id,
            pharmacy_id,
            gateway,
            gateway_order_id,
            amount,
            currency,
            status,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'payhere', $4, $5, $6, 'pending', NOW(), NOW())
          RETURNING id
        `,
        [orderId, patientId, order.pharmacy_id, gatewayOrderId, normalizeMoney(order.total), orderCurrency]
      );

      paymentId = Number(paymentResult.rows[0]?.id);
      if (!paymentId) {
        throw new HttpError(500, "Failed to create payment record");
      }
    } else {
      await client.query(
        `
          UPDATE payments
          SET gateway_order_id = $2,
              amount = $3,
              currency = $4,
              updated_at = NOW()
          WHERE id = $1
        `,
        [paymentId, gatewayOrderId, normalizeMoney(order.total), orderCurrency]
      );
    }

    await client.query(
      `
        UPDATE orders
        SET status = 'pending_payment',
            payment_method = 'online',
            payment_status = 'pending',
            updated_at = NOW()
        WHERE id = $1
      `,
      [orderId]
    );

    const fields = buildPayHereCheckoutFields(gatewayConfig, order, {
      id: paymentId,
      gatewayOrderId,
      amount: normalizeMoney(order.total),
      currency: orderCurrency,
    });
    logPayHereCheckoutPayload(fields);
    const hostedToken = buildHostedCheckoutToken(paymentId, orderId);

    return {
      orderId,
      paymentId,
      gateway: "payhere",
      checkoutUrl: gatewayConfig.checkoutUrl,
      hostedUrl: `${hostedBaseUrl.replace(/\/$/, "")}/api/payments/payhere/hosted/${paymentId}?token=${encodeURIComponent(
        hostedToken
      )}`,
      hostedToken,
      gatewayOrderId,
      sandbox: gatewayConfig.mode !== "live",
      mode: gatewayConfig.mode,
      fields,
    };
  });

export const verifyPayHereNotification = (payload: Record<string, unknown>) => {
  const gatewayConfig = getPaymentGatewayConfig();
  const merchantId = String(payload.merchant_id ?? "");
  const orderId = String(payload.order_id ?? "");
  const amount = formatGatewayAmount(Number(payload.payhere_amount ?? 0));
  const currency = String(payload.payhere_currency ?? "LKR").trim().toUpperCase() || "LKR";
  const statusCode = String(payload.status_code ?? "");
  const md5sig = String(payload.md5sig ?? "").toUpperCase();

  if (!merchantId || !orderId || !statusCode || !md5sig) {
    return { isValid: false, reason: "Missing notification fields" };
  }

  if (merchantId !== gatewayConfig.merchantId) {
    return { isValid: false, reason: "Merchant id mismatch" };
  }

  const localMd5Sig = buildPayHereMd5Sig(
    merchantId,
    orderId,
    amount,
    currency,
    statusCode,
    gatewayConfig.merchantSecret
  );

  return {
    isValid: localMd5Sig === md5sig,
    reason: localMd5Sig === md5sig ? null : "Invalid notification checksum",
    merchantId,
    gatewayOrderId: orderId,
    amount,
    currency,
    statusCode,
  };
};

export const updatePaymentFromGatewayNotification = async (
  payload: Record<string, unknown>
): Promise<NotificationUpdateResult> =>
  withTransaction(async (client) => {
    const verification = verifyPayHereNotification(payload);
    if (!verification.isValid) {
      console.warn("[payments] ignored PayHere notify:", verification.reason);
      return { processed: false, ignoredReason: verification.reason || "Invalid notification" };
    }

    const paymentResult = await client.query(
      `
        SELECT p.*, o.status AS order_status, o.total AS order_total, COALESCE(o.currency, 'LKR') AS order_currency
        FROM payments p
        JOIN orders o ON o.id = p.order_id
        WHERE p.gateway_order_id = $1
        LIMIT 1
        FOR UPDATE OF p, o
      `,
      [verification.gatewayOrderId]
    );

    const paymentRow = paymentResult.rows[0];
    if (!paymentRow) {
      console.warn("[payments] ignored PayHere notify: payment not found", verification.gatewayOrderId);
      return { processed: false, ignoredReason: "Payment not found" };
    }

    const expectedAmount = formatGatewayAmount(Number(paymentRow.order_total ?? paymentRow.amount ?? 0));
    if (expectedAmount !== verification.amount) {
      console.warn("[payments] ignored PayHere notify: amount mismatch", {
        expectedAmount,
        receivedAmount: verification.amount,
      });
      return { processed: false, ignoredReason: "Amount mismatch" };
    }

    if (String(paymentRow.order_currency || paymentRow.currency || "LKR").toUpperCase() !== verification.currency.toUpperCase()) {
      console.warn("[payments] ignored PayHere notify: currency mismatch");
      return { processed: false, ignoredReason: "Currency mismatch" };
    }

    const nextPaymentStatus = mapPayHereStatusCode(verification.statusCode);
    const alreadyTerminal = ["paid", "refunded", "cancelled", "failed"].includes(
      String(paymentRow.status || "").toLowerCase()
    );
    if (alreadyTerminal && String(paymentRow.status || "").toLowerCase() === nextPaymentStatus) {
      const existingInvoice = await loadInvoiceSummary(client, Number(paymentRow.order_id));
      return {
        processed: true,
        orderId: Number(paymentRow.order_id),
        patientId: Number(paymentRow.patient_id),
        pharmacyId: Number(paymentRow.pharmacy_id),
        paymentId: Number(paymentRow.id),
        paymentStatus: nextPaymentStatus,
        invoiceId: existingInvoice?.id ?? null,
        invoiceNo: existingInvoice?.invoiceNo ?? null,
      };
    }

    await client.query(
      `
        UPDATE payments
        SET gateway_payment_id = COALESCE($2, gateway_payment_id),
            status = $3,
            method = COALESCE($4, method),
            card_no_masked = COALESCE($5, card_no_masked),
            status_message = $6,
            raw_payload = $7::jsonb,
            verified_at = CASE WHEN $3 = 'paid' THEN COALESCE(verified_at, NOW()) ELSE verified_at END,
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        Number(paymentRow.id),
        payload.payment_id ? String(payload.payment_id) : null,
        nextPaymentStatus,
        payload.method ? String(payload.method) : null,
        payload.card_no ? String(payload.card_no) : payload.card_no_masked ? String(payload.card_no_masked) : null,
        payload.status_message ? String(payload.status_message) : `Gateway status ${verification.statusCode}`,
        JSON.stringify(payload),
      ]
    );

    let invoice: InvoiceSummary | null = null;
    if (nextPaymentStatus === "paid") {
      const nextOrderStatus = await getPostPaymentOrderStatus(client, Number(paymentRow.order_id));
      await client.query(
        `
          UPDATE orders
          SET payment_method = 'online',
              payment_status = 'paid',
              paid_at = COALESCE(paid_at, NOW()),
              status = CASE
                WHEN status = 'pending_payment' THEN $2
                ELSE status
              END,
              updated_at = NOW()
          WHERE id = $1
        `,
        [Number(paymentRow.order_id), nextOrderStatus]
      );
      invoice = await createInvoiceForPaidOrderTx(client, Number(paymentRow.order_id));
    } else {
      await client.query(
        `
          UPDATE orders
          SET payment_method = COALESCE(payment_method, 'online'),
              payment_status = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [Number(paymentRow.order_id), nextPaymentStatus]
      );
    }

    return {
      processed: true,
      orderId: Number(paymentRow.order_id),
      patientId: Number(paymentRow.patient_id),
      pharmacyId: Number(paymentRow.pharmacy_id),
      paymentId: Number(paymentRow.id),
      paymentStatus: nextPaymentStatus,
      invoiceId: invoice?.id ?? null,
      invoiceNo: invoice?.invoiceNo ?? null,
    };
  });

export const getPaymentStatus = async (
  orderId: number,
  actor: PaymentAccessContext
): Promise<PaymentStatusSummary> =>
  withTransaction(async (client) => {
    const order = await getGatewayOrderRecord(client, orderId);
    const role = String(actor.role || "").toLowerCase();
    if (role === "patient" || role === "user") {
      if (Number(order.patient_id) !== actor.userId) {
        throw new HttpError(403, "You do not have access to this payment");
      }
    } else if (role === "pharmacist") {
      const pharmacy = await client.query(
        `SELECT pharmacy_id FROM pharmacist_pharmacies WHERE user_id = $1 LIMIT 1`,
        [actor.userId]
      );
      if (Number(pharmacy.rows[0]?.pharmacy_id ?? 0) !== Number(order.pharmacy_id)) {
        throw new HttpError(403, "You do not have access to this payment");
      }
    } else if (role !== "admin") {
      throw new HttpError(403, "You do not have access to this payment");
    }

    const paymentRow = await loadLatestPaymentRow(client, orderId);
    const invoice = await loadInvoiceSummary(client, orderId);
    const paymentMethod = order.payment_method ?? null;
    const paymentStatus = (order.payment_status ?? paymentRow?.status ?? null) as PaymentStatus | null;
    const updatedAtSource = paymentRow?.updated_at ?? order.updated_at ?? order.paid_at ?? order.created_at ?? null;

    return {
      orderId,
      orderStatus: order.status,
      paymentMethod,
      paymentStatus,
      paidAt: order.paid_at ? new Date(order.paid_at).toISOString() : null,
      amount: normalizeMoney(order.total),
      currency: order.currency || "LKR",
      gatewayPaymentId: paymentRow?.gateway_payment_id ?? null,
      invoiceId: invoice?.id ?? null,
      invoiceNo: invoice?.invoiceNo ?? null,
      updatedAt: updatedAtSource ? new Date(updatedAtSource).toISOString() : null,
      message: buildPaymentStatusMessage({
        paymentMethod,
        paymentStatus,
        invoiceNo: invoice?.invoiceNo ?? null,
      }),
      payment: paymentRow
        ? {
            id: Number(paymentRow.id),
            gateway: paymentRow.gateway,
            gatewayPaymentId: paymentRow.gateway_payment_id ?? null,
            gatewayOrderId: paymentRow.gateway_order_id ?? null,
            amount: normalizeMoney(paymentRow.amount),
            currency: paymentRow.currency ?? order.currency ?? "LKR",
            status: paymentRow.status,
            method: paymentRow.method ?? null,
            cardNoMasked: paymentRow.card_no_masked ?? null,
            statusMessage: paymentRow.status_message ?? null,
            verifiedAt: paymentRow.verified_at ? new Date(paymentRow.verified_at).toISOString() : null,
            createdAt: new Date(paymentRow.created_at).toISOString(),
            updatedAt: new Date(paymentRow.updated_at).toISOString(),
          }
        : null,
      invoice,
    };
  });

export const getOrderInvoice = async (
  orderId: number,
  actor: PaymentAccessContext
): Promise<InvoiceDetails> =>
  withTransaction(async (client) => {
    const order = await getGatewayOrderRecord(client, orderId);
    const role = String(actor.role || "").toLowerCase();
    if (role === "patient" || role === "user") {
      if (Number(order.patient_id) !== actor.userId) {
        throw new HttpError(403, "You do not have access to this invoice");
      }
    } else if (role === "pharmacist") {
      const pharmacy = await client.query(
        `SELECT pharmacy_id FROM pharmacist_pharmacies WHERE user_id = $1 LIMIT 1`,
        [actor.userId]
      );
      if (Number(pharmacy.rows[0]?.pharmacy_id ?? 0) !== Number(order.pharmacy_id)) {
        throw new HttpError(403, "You do not have access to this invoice");
      }
    } else if (role !== "admin") {
      throw new HttpError(403, "You do not have access to this invoice");
    }

    const invoice = await loadInvoiceSummary(client, orderId);
    if (!invoice) {
      throw new HttpError(404, "Invoice not found");
    }

    const paymentRow = await loadLatestPaymentRow(client, orderId);
    const itemsResult = await client.query(
      `
        SELECT id, name, quantity, requested_quantity, approved_quantity, unit_price, total_price, status, note
        FROM (
          SELECT
            oi.id,
            mp.name,
            oi.quantity,
            oi.requested_quantity,
            oi.approved_quantity,
            oi.unit_price,
            oi.total_price,
            oi.status,
            oi.note
          FROM order_items oi
          JOIN marketplace_products mp ON mp.id = oi.marketplace_product_id
          WHERE oi.order_id = $1
        ) items
        ORDER BY id ASC
      `,
      [orderId]
    );

    return {
      invoice,
      order: {
        id: order.id,
        orderCode: order.order_code ?? null,
        status: order.status,
        fulfillmentType: order.fulfillment_type,
        notes: order.notes ?? null,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        paidAt: order.paid_at ? new Date(order.paid_at).toISOString() : null,
        createdAt: order.created_at ? new Date(order.created_at).toISOString() : null,
      },
      payment: paymentRow
        ? {
            id: Number(paymentRow.id),
            gateway: paymentRow.gateway,
            gatewayPaymentId: paymentRow.gateway_payment_id ?? null,
            gatewayOrderId: paymentRow.gateway_order_id ?? null,
            amount: normalizeMoney(paymentRow.amount),
            currency: paymentRow.currency ?? "LKR",
            status: paymentRow.status ?? null,
            method: paymentRow.method ?? null,
            cardNoMasked: paymentRow.card_no_masked ?? null,
            verifiedAt: paymentRow.verified_at ? new Date(paymentRow.verified_at).toISOString() : null,
          }
        : null,
      pharmacy: {
        id: Number(order.pharmacy_id),
        name: order.pharmacy_name,
        phone: order.pharmacy_phone ?? null,
        email: order.pharmacy_email ?? null,
        address: order.pharmacy_location ?? null,
      },
      patient: {
        id: Number(order.patient_id),
        name: order.patient_name ?? null,
        email: order.patient_email ?? null,
        phone: order.patient_phone ?? null,
      },
      items: itemsResult.rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        quantity: Number(row.quantity ?? 0),
        requestedQuantity: Number(row.requested_quantity ?? row.quantity ?? 0),
        approvedQuantity: Number(row.approved_quantity ?? row.quantity ?? 0),
        unitPrice: normalizeMoney(row.unit_price),
        totalPrice: normalizeMoney(row.total_price),
        status: row.status,
        note: row.note ?? null,
      })),
    };
  });

export const getHostedCheckoutHtml = async (
  paymentId: number,
  token: string
): Promise<HostedCheckoutDocument> =>
  withTransaction(async (client) => {
    const gatewayConfig = getPaymentGatewayConfig();
    const paymentResult = await client.query(
      `
        SELECT p.id, p.order_id, p.gateway_order_id, p.amount, p.currency, p.status
        FROM payments p
        WHERE p.id = $1
        LIMIT 1
      `,
      [paymentId]
    );

    const payment = paymentResult.rows[0];
    if (!payment) {
      throw new HttpError(404, "Payment checkout session not found");
    }

    verifyHostedCheckoutToken(token, Number(payment.id), Number(payment.order_id));
    if (String(payment.status || "").toLowerCase() !== "pending") {
      throw new HttpError(409, "This checkout session is no longer active");
    }
    const order = await getGatewayOrderRecord(client, Number(payment.order_id));
    const fields = buildPayHereCheckoutFields(gatewayConfig, order, {
      id: Number(payment.id),
      gatewayOrderId: String(payment.gateway_order_id),
      amount: normalizeMoney(payment.amount),
      currency: payment.currency || order.currency || "LKR",
    });
    const validation = validateHostedCheckoutFields(fields, gatewayConfig.merchantSecret);
    if (!validation.isValid) {
      return {
        html: buildHostedCheckoutValidationErrorHtml(validation.issues),
        formFields: {
          merchant_id: fields.merchant_id,
          return_url: fields.return_url,
          cancel_url: fields.cancel_url,
          notify_url: fields.notify_url,
          order_id: fields.order_id,
          items: fields.items,
          currency: fields.currency,
          amount: fields.amount,
          first_name: fields.first_name,
          last_name: fields.last_name,
          email: fields.email,
          phone: fields.phone,
          address: fields.address,
          city: fields.city,
          country: fields.country,
          hash: fields.hash,
        },
      };
    }

    const orderedFieldNames: Array<keyof PayHereCheckoutFields> = [
      "merchant_id",
      "return_url",
      "cancel_url",
      "notify_url",
      "order_id",
      "items",
      "currency",
      "amount",
      "first_name",
      "last_name",
      "email",
      "phone",
      "address",
      "city",
      "country",
      "hash",
      "custom_1",
      "custom_2",
    ];

    const hiddenInputs = orderedFieldNames
      .map(
        (key) =>
          `<input type="hidden" name="${escapeHtmlAttribute(String(key))}" value="${escapeHtmlAttribute(
            String(fields[key] ?? "")
          )}" />`
      )
      .join("\n");

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Redirecting to PayHere</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
      .card { background:#ffffff; border:1px solid #dbe7f0; border-radius:20px; padding:32px; max-width:420px; box-shadow:0 30px 80px -50px rgba(15,23,42,.45); text-align:center; }
      .dot { width:12px; height:12px; border-radius:999px; background:#10b981; margin:0 auto 18px; animation:pulse 1.2s infinite; }
      @keyframes pulse { 0% { transform:scale(.9); opacity:.5; } 50% { transform:scale(1.1); opacity:1; } 100% { transform:scale(.9); opacity:.5; } }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="dot"></div>
      <h1>Redirecting to secure payment</h1>
      <p>Please wait while HealthLink opens the PayHere checkout page.</p>
      <form id="payhere-form" method="post" action="${gatewayConfig.checkoutUrl}">
        ${hiddenInputs}
      </form>
      <button id="manual-submit" type="submit" form="payhere-form" style="display:none;margin-top:16px;padding:12px 18px;border:none;border-radius:999px;background:#0f172a;color:#fff;font-weight:700;cursor:pointer;">Continue to payment</button>
      <noscript><button type="submit" form="payhere-form">Continue to payment</button></noscript>
    </div>
    <script>
      (function () {
        var form = document.getElementById("payhere-form");
        var button = document.getElementById("manual-submit");
        var submitted = false;

        var submitForm = function () {
          if (!form || submitted) return;
          submitted = true;
          try {
            if (typeof form.requestSubmit === "function") {
              form.requestSubmit();
              return;
            }
          } catch (error) {}
          form.submit();
        };

        if (document.readyState === "complete" || document.readyState === "interactive") {
          setTimeout(submitForm, 50);
        } else {
          document.addEventListener("DOMContentLoaded", function () {
            setTimeout(submitForm, 50);
          }, { once: true });
        }

        setTimeout(function () {
          if (!submitted && button) {
            button.style.display = "inline-block";
          }
        }, 1500);
      })();
    </script>
  </body>
</html>`;

    return {
      html,
      formFields: {
        merchant_id: fields.merchant_id,
        return_url: fields.return_url,
        cancel_url: fields.cancel_url,
        notify_url: fields.notify_url,
        order_id: fields.order_id,
        items: fields.items,
        currency: fields.currency,
        amount: fields.amount,
        first_name: fields.first_name,
        last_name: fields.last_name,
        email: fields.email,
        phone: fields.phone,
        address: fields.address,
        city: fields.city,
        country: fields.country,
        hash: fields.hash,
      },
    };
  });
