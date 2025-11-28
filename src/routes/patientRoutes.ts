import express from "express";
import pool from "../config/db.ts";

const router = express.Router();

// ✅ Fetch all patients
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM patients ORDER BY id ASC");
    res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching patients:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
// ✅ Add a new patient
router.post("/", async (req, res) => {
  try {
    const { name, age, gender, contact_number } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    const result = await pool.query(
      "INSERT INTO patients (name, age, gender, contact_number) VALUES ($1, $2, $3, $4) RETURNING *",
      [name, age, gender, contact_number]
    );

    res.status(201).json({
      message: "✅ Patient added successfully",
      patient: result.rows[0],
    });
  } catch (err) {
    console.error("Error inserting patient:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
