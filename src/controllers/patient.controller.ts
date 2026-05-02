import type { Request, Response } from "express";
import { createPatient, listPatients } from "../services/patient.service";

export const getAllPatients = async (_req: Request, res: Response) => {
  try {
    const patients = await listPatients();
    return res.status(200).json(patients);
  } catch (error) {
    console.error("Error fetching patients:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const addPatient = async (req: Request, res: Response) => {
  try {
    const { name, age, gender, contact_number } = req.body || {};

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    const patient = await createPatient({
      name,
      age: Number.isFinite(Number(age)) ? Number(age) : null,
      gender: gender ?? null,
      contact_number: contact_number ?? null,
    });

    return res.status(201).json({
      message: "✅ Patient added successfully",
      patient,
    });
  } catch (error) {
    console.error("Error inserting patient:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};
