import pool from "../config/db";

export const listPatients = async () => {
  const result = await pool.query("SELECT * FROM patients ORDER BY id ASC");
  return result.rows;
};

export const createPatient = async (input: {
  name: string;
  age?: number | null;
  gender?: string | null;
  contact_number?: string | null;
}) => {
  const result = await pool.query(
    "INSERT INTO patients (name, age, gender, contact_number) VALUES ($1, $2, $3, $4) RETURNING *",
    [input.name, input.age ?? null, input.gender ?? null, input.contact_number ?? null]
  );

  return result.rows[0];
};
