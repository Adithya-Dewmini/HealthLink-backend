import express from "express";
import pool from "../config/db";
import { authenticateToken } from "../middleware/authenticateToken";

const router = express.Router();

const ensurePatientRole = (req: any, res: any) => {
  const role = req.user?.role;
  if (role !== "patient" && role !== "user") {
    res.status(403).json({ message: "Only patients can access favorites" });
    return false;
  }
  return true;
};

const validateFavoritePayload = (body: any) => {
  const itemId = Number(body?.itemId);
  const itemType = typeof body?.itemType === "string" ? body.itemType.trim().toLowerCase() : "";

  if (!Number.isInteger(itemId) || itemId <= 0) {
    throw new Error("Valid itemId is required");
  }

  if (itemType !== "doctor" && itemType !== "pharmacy") {
    throw new Error("itemType must be 'doctor' or 'pharmacy'");
  }

  return { itemId, itemType };
};

router.get("/", authenticateToken, async (req: any, res) => {
  try {
    if (!ensurePatientRole(req, res)) return;
    const patientId = req.user?.id;

    const [doctorResult, pharmacyResult] = await Promise.all([
      pool.query(
        `
          SELECT
            f.id AS favorite_id,
            f.item_id,
            f.created_at,
            d.id AS doctor_id,
            u.name,
            d.specialization,
            d.experience_years
          FROM favorites f
          JOIN doctors d ON d.id = f.item_id
          JOIN users u ON u.id = d.user_id
          WHERE f.patient_id = $1
            AND f.item_type = 'doctor'
          ORDER BY f.created_at DESC
        `,
        [patientId]
      ),
      pool.query(
        `
          SELECT
            f.id AS favorite_id,
            f.item_id,
            f.created_at,
            p.id,
            p.name,
            p.location,
            p.image_url,
            p.rating,
            p.status
          FROM favorites f
          JOIN pharmacies p ON p.id = f.item_id
          WHERE f.patient_id = $1
            AND f.item_type = 'pharmacy'
          ORDER BY f.created_at DESC
        `,
        [patientId]
      ),
    ]);

    return res.json({
      doctors: doctorResult.rows.map((row: any) => ({
        favoriteId: row.favorite_id,
        id: Number(row.doctor_id),
        itemId: Number(row.item_id),
        name: row.name,
        specialization: row.specialization ?? "General Physician",
        experienceYears:
          row.experience_years === null || row.experience_years === undefined
            ? null
            : Number(row.experience_years),
        createdAt: row.created_at,
      })),
      pharmacies: pharmacyResult.rows.map((row: any) => ({
        favoriteId: row.favorite_id,
        id: Number(row.id),
        itemId: Number(row.item_id),
        name: row.name,
        location: row.location ?? "N/A",
        imageUrl: row.image_url ?? null,
        rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
        status: row.status ?? null,
        createdAt: row.created_at,
      })),
    });
  } catch (err) {
    console.error("Get favorites error:", err);
    return res.status(500).json({ message: "Failed to fetch favorites" });
  }
});

router.post("/", authenticateToken, async (req: any, res) => {
  try {
    if (!ensurePatientRole(req, res)) return;
    const patientId = req.user?.id;
    const { itemId, itemType } = validateFavoritePayload(req.body);

    const existenceQuery =
      itemType === "doctor"
        ? `SELECT id FROM doctors WHERE id = $1 LIMIT 1`
        : `SELECT id FROM pharmacies WHERE id = $1 LIMIT 1`;
    const existenceResult = await pool.query(existenceQuery, [itemId]);

    if (!existenceResult.rows.length) {
      return res.status(404).json({ message: `${itemType} not found` });
    }

    const result = await pool.query(
      `
        INSERT INTO favorites (patient_id, item_id, item_type)
        VALUES ($1, $2, $3)
        ON CONFLICT (patient_id, item_id, item_type) DO NOTHING
        RETURNING id, patient_id, item_id, item_type, created_at
      `,
      [patientId, itemId, itemType]
    );

    if (!result.rows.length) {
      return res.status(409).json({ message: "Already in favorites" });
    }

    return res.status(201).json({
      message: "Added to favorites",
      favorite: result.rows[0],
    });
  } catch (err: any) {
    if (err instanceof Error && err.message) {
      return res.status(400).json({ message: err.message });
    }
    console.error("Create favorite error:", err);
    return res.status(500).json({ message: "Failed to save favorite" });
  }
});

router.delete("/", authenticateToken, async (req: any, res) => {
  try {
    if (!ensurePatientRole(req, res)) return;
    const patientId = req.user?.id;
    const { itemId, itemType } = validateFavoritePayload(req.body);

    const result = await pool.query(
      `
        DELETE FROM favorites
        WHERE patient_id = $1
          AND item_id = $2
          AND item_type = $3
        RETURNING id
      `,
      [patientId, itemId, itemType]
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
