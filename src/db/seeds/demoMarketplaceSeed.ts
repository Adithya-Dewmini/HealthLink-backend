import bcrypt from "bcryptjs";
import pool from "../../config/db";
import { getInventorySchema, quoteIdent } from "../../modules/pharmacy/schema";

const DEMO_PASSWORD = "DemoPass123!";
const DEMO_TAG = "[DEMO]";

const ensureUser = async (input: {
  name: string;
  email: string;
  role: string;
}) => {
  const existing = await pool.query<{ id: number }>(
    `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [input.email]
  );
  if (existing.rows[0]) {
    return Number(existing.rows[0].id);
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const created = await pool.query<{ id: number }>(
    `
      INSERT INTO users (name, email, password, password_hash, is_password_set, role, created_at, updated_at)
      VALUES ($1, $2, $3, $3, TRUE, $4, NOW(), NOW())
      RETURNING id
    `,
    [input.name, input.email, passwordHash, input.role]
  );
  return Number(created.rows[0].id);
};

const ensurePharmacy = async () => {
  const existing = await pool.query<{ id: number }>(
    `SELECT id FROM pharmacies WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [`${DEMO_TAG} HealthLink Demo Pharmacy`]
  );
  if (existing.rows[0]) {
    return Number(existing.rows[0].id);
  }

  const created = await pool.query<{ id: number }>(
    `
      INSERT INTO pharmacies (
        name, location, phone, email, rating, status, verification_status, verification_notes, created_at
      )
      VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 'approved', 'Seeded demo pharmacy', NOW())
      RETURNING id
    `,
    [
      `${DEMO_TAG} HealthLink Demo Pharmacy`,
      "Colombo",
      "+94 11 000 0000",
      "demo.pharmacy@healthlink.local",
      4.9,
    ]
  );
  return Number(created.rows[0].id);
};

const ensurePharmacistLink = async (userId: number, pharmacyId: number) => {
  await pool.query(
    `
      INSERT INTO pharmacist_pharmacies (user_id, pharmacy_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, pharmacy_id) DO NOTHING
    `,
    [userId, pharmacyId]
  );
};

const ensureCategory = async (name: string) => {
  const existing = await pool.query<{ id: number }>(
    `SELECT id FROM categories WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [name]
  );
  if (existing.rows[0]) return Number(existing.rows[0].id);
  const created = await pool.query<{ id: number }>(
    `INSERT INTO categories (name, created_at) VALUES ($1, NOW()) RETURNING id`,
    [name]
  );
  return Number(created.rows[0].id);
};

const ensureBrand = async (name: string) => {
  const existing = await pool.query<{ id: number }>(
    `SELECT id FROM brands WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [name]
  );
  if (existing.rows[0]) return Number(existing.rows[0].id);
  const created = await pool.query<{ id: number }>(
    `INSERT INTO brands (name, created_at) VALUES ($1, NOW()) RETURNING id`,
    [name]
  );
  return Number(created.rows[0].id);
};

const ensureMedicine = async (input: {
  name: string;
  genericName?: string;
  price: number;
  categoryId: number;
  brandId: number;
}) => {
  const existing = await pool.query<{ id: number }>(
    `SELECT id FROM medicines WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [input.name]
  );
  if (existing.rows[0]) return Number(existing.rows[0].id);

  const created = await pool.query<{ id: number }>(
    `
      INSERT INTO medicines (
        name, generic_name, category_id, brand_id, description, quantity, price, avg_price, created_at
      )
      VALUES ($1, $2, $3, $4, $5, 100, $6, $6, NOW())
      RETURNING id
    `,
    [
      input.name,
      input.genericName ?? null,
      input.categoryId,
      input.brandId,
      `${DEMO_TAG} demo medicine`,
      input.price,
    ]
  );
  return Number(created.rows[0].id);
};

const ensureInventory = async (pharmacyId: number, medicineId: number, quantity: number, price: number) => {
  const client = await pool.connect();
  try {
    const schema = await getInventorySchema(client);
    const existing = await client.query(
      `
        SELECT 1
        FROM inventory
        WHERE ${quoteIdent(schema.pharmacyCol)} = $1
          AND ${quoteIdent(schema.medicineCol)} = $2
        LIMIT 1
      `,
      [pharmacyId, medicineId]
    );

    if (existing.rows.length) {
      const updateClauses = [`${quoteIdent(schema.stockCol)} = $3`];
      if (schema.priceCol) {
        updateClauses.push(`${quoteIdent(schema.priceCol)} = $4`);
      }
      if (schema.reservedCol) {
        updateClauses.push(`${quoteIdent(schema.reservedCol)} = 0`);
      }
      await client.query(
        `
          UPDATE inventory
          SET ${updateClauses.join(", ")}
          WHERE ${quoteIdent(schema.pharmacyCol)} = $1
            AND ${quoteIdent(schema.medicineCol)} = $2
        `,
        [pharmacyId, medicineId, quantity, price]
      );
      return;
    }

    const columns = [
      quoteIdent(schema.pharmacyCol),
      quoteIdent(schema.medicineCol),
      quoteIdent(schema.stockCol),
      ...(schema.priceCol ? [quoteIdent(schema.priceCol)] : []),
      ...(schema.reservedCol ? [quoteIdent(schema.reservedCol)] : []),
    ];
    const values = [pharmacyId, medicineId, quantity, ...(schema.priceCol ? [price] : []), ...(schema.reservedCol ? [0] : [])];
    const placeholders = values.map((_, index) => `$${index + 1}`);

    await client.query(
      `
        INSERT INTO inventory (${columns.join(", ")})
        VALUES (${placeholders.join(", ")})
      `,
      values
    );
  } finally {
    client.release();
  }
};

const ensureMarketplaceProduct = async (input: {
  pharmacyId: number;
  medicineId: number;
  name: string;
  genericName?: string;
  brand?: string;
  category?: string;
  price: number;
  discountPrice?: number | null;
}) => {
  const existing = await pool.query<{ id: number }>(
    `
      SELECT id
      FROM marketplace_products
      WHERE pharmacy_id = $1
        AND inventory_item_id = $2
      LIMIT 1
    `,
    [input.pharmacyId, input.medicineId]
  );

  if (existing.rows[0]) return Number(existing.rows[0].id);

  const created = await pool.query<{ id: number }>(
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
        requires_prescription,
        is_featured,
        is_active,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, TRUE, TRUE, NOW(), NOW())
      RETURNING id
    `,
    [
      input.pharmacyId,
      input.medicineId,
      input.name,
      input.genericName ?? null,
      input.brand ?? null,
      `${DEMO_TAG} storefront medicine`,
      input.category ?? null,
      input.price,
      input.discountPrice ?? null,
    ]
  );
  return Number(created.rows[0].id);
};

const ensurePrescription = async (patientId: number) => {
  const idType = await pool.query<{ data_type: string }>(
    `
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'prescriptions'
        AND column_name = 'id'
      LIMIT 1
    `
  );

  const isUuid = String(idType.rows[0]?.data_type || "").toLowerCase() === "uuid";
  const existing = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM prescriptions WHERE qr_code = $1 LIMIT 1`,
    [`${DEMO_TAG}-RX-SEED`]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const created = await pool.query<{ id: string }>(
    isUuid
      ? `
          INSERT INTO prescriptions (id, consultation_id, medical_center_id, qr_code, status, is_seen, issued_at)
          VALUES (gen_random_uuid(), NULL, NULL, $1, 'pending', FALSE, NOW())
          RETURNING id::text AS id
        `
      : `
          INSERT INTO prescriptions (consultation_id, medical_center_id, qr_code, status, is_seen, issued_at)
          VALUES (NULL, NULL, $1, 'pending', FALSE, NOW())
          RETURNING id::text AS id
        `,
    [`${DEMO_TAG}-RX-SEED`]
  );

  await pool.query(
    `
      INSERT INTO prescription_items (
        prescription_id, medicine_id, medicine_name, quantity, dosage, frequency, duration, instructions, dispensed_quantity
      )
      VALUES ($1::${isUuid ? "uuid" : "int"}, NULL, $2, 2, '500mg', 'Twice daily', '5 days', 'Take after meals', 0)
      ON CONFLICT DO NOTHING
    `,
    [created.rows[0].id, `${DEMO_TAG} Paracetamol 500mg`]
  );

  return created.rows[0].id;
};

async function main() {
  const patientId = await ensureUser({
    name: `${DEMO_TAG} Demo Patient`,
    email: "demo.patient@healthlink.local",
    role: "patient",
  });
  const doctorUserId = await ensureUser({
    name: `${DEMO_TAG} Demo Doctor`,
    email: "demo.doctor@healthlink.local",
    role: "doctor",
  });
  const pharmacistUserId = await ensureUser({
    name: `${DEMO_TAG} Demo Pharmacist`,
    email: "demo.pharmacist@healthlink.local",
    role: "pharmacist",
  });

  await pool.query(
    `
      INSERT INTO doctors (user_id, specialization, experience_years)
      VALUES ($1, 'General Medicine', 8)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [doctorUserId]
  );

  const pharmacyId = await ensurePharmacy();
  await ensurePharmacistLink(pharmacistUserId, pharmacyId);

  const analgesicsCategoryId = await ensureCategory(`${DEMO_TAG} Analgesics`);
  const demoBrandId = await ensureBrand(`${DEMO_TAG} MediCore`);

  const medicineA = await ensureMedicine({
    name: `${DEMO_TAG} Paracetamol 500mg`,
    genericName: "Paracetamol",
    price: 120,
    categoryId: analgesicsCategoryId,
    brandId: demoBrandId,
  });
  const medicineB = await ensureMedicine({
    name: `${DEMO_TAG} Vitamin C 1000mg`,
    genericName: "Ascorbic Acid",
    price: 95,
    categoryId: analgesicsCategoryId,
    brandId: demoBrandId,
  });

  await ensureInventory(pharmacyId, medicineA, 80, 120);
  await ensureInventory(pharmacyId, medicineB, 60, 95);

  const marketplaceProductA = await ensureMarketplaceProduct({
    pharmacyId,
    medicineId: medicineA,
    name: `${DEMO_TAG} Paracetamol 500mg`,
    genericName: "Paracetamol",
    brand: `${DEMO_TAG} MediCore`,
    category: `${DEMO_TAG} Analgesics`,
    price: 120,
    discountPrice: 110,
  });
  const marketplaceProductB = await ensureMarketplaceProduct({
    pharmacyId,
    medicineId: medicineB,
    name: `${DEMO_TAG} Vitamin C 1000mg`,
    genericName: "Ascorbic Acid",
    brand: `${DEMO_TAG} MediCore`,
    category: `${DEMO_TAG} Supplements`,
    price: 95,
    discountPrice: 90,
  });

  const existingOrder = await pool.query<{ id: number }>(
    `
      SELECT id
      FROM orders
      WHERE patient_id = $1 AND pharmacy_id = $2 AND notes = $3
      LIMIT 1
    `,
    [patientId, pharmacyId, `${DEMO_TAG} demo order`]
  );

  const orderId =
    existingOrder.rows[0]?.id ??
    Number(
      (
        await pool.query<{ id: number }>(
          `
            INSERT INTO orders (
              patient_id, pharmacy_id, status, subtotal, discount_total, total, fulfillment_type, notes, created_at, updated_at
            )
            VALUES ($1, $2, 'ready_for_pickup', 215, 15, 200, 'pickup', $3, NOW(), NOW())
            RETURNING id
          `,
          [patientId, pharmacyId, `${DEMO_TAG} demo order`]
        )
      ).rows[0].id
    );

  await pool.query(
    `
      INSERT INTO order_items (
        order_id, marketplace_product_id, inventory_item_id, quantity, unit_price, total_price, status, created_at, updated_at
      )
      SELECT $1, $2, $3, 1, 110, 110, 'ready_for_pickup', NOW(), NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM order_items WHERE order_id = $1 AND marketplace_product_id = $2
      )
    `,
    [orderId, marketplaceProductA, medicineA]
  );
  await pool.query(
    `
      INSERT INTO order_items (
        order_id, marketplace_product_id, inventory_item_id, quantity, unit_price, total_price, status, created_at, updated_at
      )
      SELECT $1, $2, $3, 1, 90, 90, 'ready_for_pickup', NOW(), NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM order_items WHERE order_id = $1 AND marketplace_product_id = $2
      )
    `,
    [orderId, marketplaceProductB, medicineB]
  );

  const prescriptionId = await ensurePrescription(patientId);

  await pool.query(
    `
      INSERT INTO notifications (
        user_id, title, body, type, is_read, metadata, created_at, updated_at
      )
      SELECT $1, $2, $3, 'order_ready_for_pickup', FALSE, $4::jsonb, NOW(), NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications WHERE user_id = $1 AND title = $2
      )
    `,
    [
      patientId,
      `${DEMO_TAG} Demo order ready`,
      `Order #${orderId} is ready for pickup.`,
      JSON.stringify({ orderId, pharmacyId }),
    ]
  );

  await pool.query(
    `
      INSERT INTO activity_logs (
        user_id, order_id, prescription_id, type, title, description, metadata, created_at
      )
      SELECT $1, $2, $3::uuid, 'order_ready_for_pickup', $4, $5, $6::jsonb, NOW()
      WHERE EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'activity_logs' AND column_name = 'prescription_id'
      )
      AND NOT EXISTS (
        SELECT 1 FROM activity_logs WHERE user_id = $1 AND order_id = $2 AND title = $4
      )
    `,
    [
      patientId,
      orderId,
      /^[0-9a-f-]{36}$/i.test(prescriptionId) ? prescriptionId : null,
      `${DEMO_TAG} Demo order updated`,
      `Demo order #${orderId} is ready for pickup.`,
      JSON.stringify({ orderId, pharmacyId }),
    ]
  ).catch(async () => {
    await pool.query(
      `
        INSERT INTO activity_logs (user_id, order_id, type, title, description, metadata, created_at)
        SELECT $1, $2, 'order_ready_for_pickup', $3, $4, $5::jsonb, NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM activity_logs WHERE user_id = $1 AND order_id = $2 AND title = $3
        )
      `,
      [
        patientId,
        orderId,
        `${DEMO_TAG} Demo order updated`,
        `Demo order #${orderId} is ready for pickup.`,
        JSON.stringify({ orderId, pharmacyId }),
      ]
    );
  });

  console.log("Demo marketplace seed complete");
  console.log({
    patientEmail: "demo.patient@healthlink.local",
    doctorEmail: "demo.doctor@healthlink.local",
    pharmacistEmail: "demo.pharmacist@healthlink.local",
    password: DEMO_PASSWORD,
    pharmacyId,
    orderId,
    prescriptionId,
  });
}

main()
  .catch((error) => {
    console.error("Demo seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
