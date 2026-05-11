import express from "express";
import pool from "../config/db";
import { authenticateToken } from "../middleware/authenticateToken";

const router = express.Router();

type FavoriteType = "doctor" | "pharmacy" | "medical_center";

const FAVORITE_TYPES: FavoriteType[] = ["doctor", "pharmacy", "medical_center"];

const ensurePatientRole = (req: any, res: any) => {
  const role = req.user?.role;
  if (role !== "patient" && role !== "user") {
    res.status(403).json({ message: "Only patients can access favorites" });
    return false;
  }
  return true;
};

const isFavoriteType = (value: unknown): value is FavoriteType =>
  typeof value === "string" && FAVORITE_TYPES.includes(value.trim().toLowerCase() as FavoriteType);

const normalizeFavoriteType = (value: unknown): FavoriteType => {
  const next = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!isFavoriteType(next)) {
    throw new Error("entityType must be 'doctor', 'pharmacy', or 'medical_center'");
  }
  return next;
};

const normalizeFavoriteIdentity = (body: any) => {
  const entityType = normalizeFavoriteType(body?.entityType ?? body?.itemType);
  const rawEntityId = body?.entityId ?? body?.itemId;
  const entityId = String(rawEntityId ?? "").trim();

  if (!entityId) {
    throw new Error("Valid entityId is required");
  }

  if ((entityType === "doctor" || entityType === "pharmacy") && (!/^\d+$/.test(entityId) || Number(entityId) <= 0)) {
    throw new Error(`Valid ${entityType} entityId is required`);
  }

  return {
    entityType,
    entityId,
    itemId: /^\d+$/.test(entityId) ? Number(entityId) : null,
  };
};

const mapFavoriteItem = (row: any) => ({
  favoriteId: Number(row.favorite_id),
  entityType: row.entity_type as FavoriteType,
  entityId: String(row.entity_id),
  unavailable: !row.is_available,
  createdAt: row.created_at,
  name: row.display_name || "Unavailable favorite",
  subtitle: row.subtitle || null,
  location: row.location || null,
  imageUrl: row.image_url || null,
  status: row.status || null,
  doctorId: row.doctor_id === null || row.doctor_id === undefined ? null : Number(row.doctor_id),
  clinicId: row.clinic_id ? String(row.clinic_id) : null,
  clinicName: row.clinic_name || null,
  specialization: row.specialization || null,
  medicalCenterSpecialty: row.medical_center_specialty || null,
  experienceYears:
    row.experience_years === null || row.experience_years === undefined ? null : Number(row.experience_years),
  pharmacyId: row.pharmacy_id === null || row.pharmacy_id === undefined ? null : Number(row.pharmacy_id),
  medicalCenterId: row.medical_center_id ? String(row.medical_center_id) : null,
  nextAvailable: row.next_available || null,
  waitTime: row.wait_time || null,
  rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
  reviewCount: row.review_count === null || row.review_count === undefined ? null : Number(row.review_count),
});

router.get("/", authenticateToken, async (req: any, res) => {
  try {
    if (!ensurePatientRole(req, res)) return;
    const patientId = req.user?.id;

    const result = await pool.query(
      `
        SELECT
          f.id AS favorite_id,
          f.item_type AS entity_type,
          f.entity_id,
          f.created_at,
          CASE
            WHEN f.item_type = 'doctor' THEN d.id IS NOT NULL
            WHEN f.item_type = 'pharmacy' THEN p.id IS NOT NULL
            WHEN f.item_type = 'medical_center' THEN mc.id IS NOT NULL
            ELSE FALSE
          END AS is_available,
          d.id AS doctor_id,
          p.id AS pharmacy_id,
          mc.id::text AS medical_center_id,
          COALESCE(du.name, p.name, mc.name, 'Unavailable favorite') AS display_name,
          CASE
            WHEN f.item_type = 'doctor' THEN COALESCE(d.specialization, 'General Physician')
            WHEN f.item_type = 'pharmacy' THEN COALESCE(p.location, 'Not provided')
            WHEN f.item_type = 'medical_center' THEN COALESCE(split_part(mc.address, ',', 1), mc.city, 'Sri Lanka')
            ELSE NULL
          END AS subtitle,
          CASE
            WHEN f.item_type = 'doctor' THEN COALESCE(clinic_assignment.clinic_name, 'Medical Center')
            WHEN f.item_type = 'pharmacy' THEN COALESCE(p.location, 'Not provided')
            WHEN f.item_type = 'medical_center' THEN COALESCE(split_part(mc.address, ',', 1), mc.city, 'Sri Lanka')
            ELSE NULL
          END AS location,
          COALESCE(du.profile_image, p.image_url, p.logo_url, p.cover_image_url, NULL) AS image_url,
          CASE
            WHEN f.item_type = 'doctor' THEN COALESCE(clinic_assignment.clinic_name, 'Medical Center')
            WHEN f.item_type = 'medical_center' THEN mc.name
            ELSE NULL
          END AS clinic_name,
          clinic_assignment.clinic_id::text AS clinic_id,
          d.specialization,
          d.experience_years,
          mc.type AS medical_center_specialty,
          COALESCE(mc.status, p.status, NULL) AS status,
          p.rating::float AS rating,
          NULL::int AS review_count,
          avg_wait.average_wait_minutes::text AS wait_time,
          next_session.start_time::text AS next_available
        FROM favorites f
        LEFT JOIN doctors d
          ON f.item_type = 'doctor'
         AND d.id::text = f.entity_id
        LEFT JOIN users du
          ON du.id = d.user_id
        LEFT JOIN LATERAL (
          SELECT
            center.id AS clinic_id,
            center.name AS clinic_name
          FROM medical_center_doctors mcd
          JOIN medical_centers center ON center.id = mcd.medical_center_id
          WHERE d.user_id IS NOT NULL
            AND mcd.doctor_id = d.user_id
            AND UPPER(COALESCE(mcd.status::text, '')) = 'ACTIVE'
          ORDER BY center.name ASC
          LIMIT 1
        ) clinic_assignment ON TRUE
        LEFT JOIN pharmacies p
          ON f.item_type = 'pharmacy'
         AND p.id::text = f.entity_id
        LEFT JOIN medical_centers mc
          ON f.item_type = 'medical_center'
         AND mc.id::text = f.entity_id
        LEFT JOIN LATERAL (
          SELECT ROUND(AVG(EXTRACT(EPOCH FROM (qp.completed_at - qp.started_at)) / 60.0))::int AS average_wait_minutes
          FROM queue_patients qp
          JOIN queues q ON q.id = qp.queue_id
          WHERE mc.id IS NOT NULL
            AND q.medical_center_id = mc.id
            AND qp.status = 'COMPLETED'
            AND qp.started_at IS NOT NULL
            AND qp.completed_at IS NOT NULL
        ) avg_wait ON TRUE
        LEFT JOIN LATERAL (
          SELECT s.start_time
          FROM medical_center_doctor_schedule s
          WHERE mc.id IS NOT NULL
            AND s.medical_center_id = mc.id
            AND s.is_active = TRUE
          ORDER BY s.date ASC, s.start_time ASC
          LIMIT 1
        ) next_session ON TRUE
        WHERE f.patient_id = $1
        ORDER BY f.created_at DESC
      `,
      [patientId]
    );

    const items = result.rows.map(mapFavoriteItem);
    const doctors = items
      .filter((item) => item.entityType === "doctor")
      .map((item) => ({
        favoriteId: item.favoriteId,
        id: item.doctorId ?? Number(item.entityId),
        itemId: item.doctorId ?? Number(item.entityId),
        entityId: item.entityId,
        name: item.name,
        specialization: item.specialization ?? "General Physician",
        clinicId: item.clinicId,
        clinicName: item.clinicName,
        profileImage: item.imageUrl,
        experienceYears: item.experienceYears,
        rating: item.rating,
        reviewCount: item.reviewCount,
        unavailable: item.unavailable,
        createdAt: item.createdAt,
      }));
    const pharmacies = items
      .filter((item) => item.entityType === "pharmacy")
      .map((item) => ({
        favoriteId: item.favoriteId,
        id: item.pharmacyId ?? Number(item.entityId),
        itemId: item.pharmacyId ?? Number(item.entityId),
        entityId: item.entityId,
        name: item.name,
        location: item.location ?? "Not provided",
        imageUrl: item.imageUrl,
        rating: item.rating,
        status: item.status,
        unavailable: item.unavailable,
        createdAt: item.createdAt,
      }));
    const medicalCenters = items
      .filter((item) => item.entityType === "medical_center")
      .map((item) => ({
        favoriteId: item.favoriteId,
        id: item.medicalCenterId ?? item.entityId,
        itemId: item.medicalCenterId ?? item.entityId,
        entityId: item.entityId,
        name: item.name,
        location: item.location ?? "Sri Lanka",
        imageUrl: item.imageUrl,
        status: item.status,
        specialty: item.medicalCenterSpecialty,
        waitTime: item.waitTime,
        nextAvailable: item.nextAvailable,
        unavailable: item.unavailable,
        createdAt: item.createdAt,
      }));

    return res.json({
      items,
      doctors,
      pharmacies,
      medicalCenters,
    });
  } catch (err) {
    console.error("Get favorites error:", err);
    return res.status(500).json({ message: "Failed to fetch favorites" });
  }
});

router.get("/check/:entityType/:entityId", authenticateToken, async (req: any, res) => {
  try {
    if (!ensurePatientRole(req, res)) return;
    const patientId = req.user?.id;
    const entityType = normalizeFavoriteType(req.params.entityType);
    const entityId = String(req.params.entityId || "").trim();

    if (!entityId) {
      return res.status(400).json({ message: "entityId is required" });
    }

    const result = await pool.query(
      `
        SELECT 1
        FROM favorites
        WHERE patient_id = $1
          AND item_type = $2
          AND entity_id = $3
        LIMIT 1
      `,
      [patientId, entityType, entityId]
    );

    return res.json({ isFavorite: result.rows.length > 0 });
  } catch (err: any) {
    if (err instanceof Error && err.message) {
      return res.status(400).json({ message: err.message });
    }
    console.error("Check favorite error:", err);
    return res.status(500).json({ message: "Failed to check favorite" });
  }
});

router.post("/", authenticateToken, async (req: any, res) => {
  try {
    if (!ensurePatientRole(req, res)) return;
    const patientId = req.user?.id;
    const { entityId, entityType, itemId } = normalizeFavoriteIdentity(req.body);

    const existenceQuery =
      entityType === "doctor"
        ? `SELECT id::text AS id FROM doctors WHERE id = $1::int LIMIT 1`
        : entityType === "pharmacy"
          ? `SELECT id::text AS id FROM pharmacies WHERE id = $1::int LIMIT 1`
          : `SELECT id::text AS id FROM medical_centers WHERE id = $1::uuid LIMIT 1`;
    const existenceResult = await pool.query(existenceQuery, [entityId]);

    if (!existenceResult.rows.length) {
      return res.status(404).json({ message: `${entityType} not found` });
    }

    const result = await pool.query(
      `
        INSERT INTO favorites (patient_id, item_id, entity_id, item_type)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (patient_id, item_type, entity_id) DO NOTHING
        RETURNING id, patient_id, item_id, entity_id, item_type, created_at
      `,
      [patientId, itemId, entityId, entityType]
    );

    if (!result.rows.length) {
      return res.status(200).json({
        message: "Already in favorites",
        favorite: null,
        success: true,
      });
    }

    return res.status(201).json({
      message: "Added to favorites",
      favorite: result.rows[0],
      success: true,
    });
  } catch (err: any) {
    if (err instanceof Error && err.message) {
      return res.status(400).json({ message: err.message });
    }
    console.error("Create favorite error:", err);
    return res.status(500).json({ message: "Failed to save favorite" });
  }
});

router.delete("/:entityType/:entityId", authenticateToken, async (req: any, res) => {
  try {
    if (!ensurePatientRole(req, res)) return;
    const patientId = req.user?.id;
    const entityType = normalizeFavoriteType(req.params.entityType);
    const entityId = String(req.params.entityId || "").trim();

    if (!entityId) {
      return res.status(400).json({ message: "entityId is required" });
    }

    const result = await pool.query(
      `
        DELETE FROM favorites
        WHERE patient_id = $1
          AND item_type = $2
          AND entity_id = $3
        RETURNING id
      `,
      [patientId, entityType, entityId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Favorite not found" });
    }

    return res.json({ message: "Removed from favorites", success: true });
  } catch (err: any) {
    if (err instanceof Error && err.message) {
      return res.status(400).json({ message: err.message });
    }
    console.error("Delete favorite error:", err);
    return res.status(500).json({ message: "Failed to remove favorite" });
  }
});

router.delete("/", authenticateToken, async (req: any, res) => {
  try {
    if (!ensurePatientRole(req, res)) return;
    const patientId = req.user?.id;
    const { entityId, entityType } = normalizeFavoriteIdentity(req.body);

    const result = await pool.query(
      `
        DELETE FROM favorites
        WHERE patient_id = $1
          AND item_type = $2
          AND entity_id = $3
        RETURNING id
      `,
      [patientId, entityType, entityId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Favorite not found" });
    }

    return res.json({ message: "Removed from favorites", success: true });
  } catch (err: any) {
    if (err instanceof Error && err.message) {
      return res.status(400).json({ message: err.message });
    }
    console.error("Delete favorite error:", err);
    return res.status(500).json({ message: "Failed to remove favorite" });
  }
});

export default router;
