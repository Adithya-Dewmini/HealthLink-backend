CREATE TABLE IF NOT EXISTS specialties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_specialties_name_lower
ON specialties(LOWER(TRIM(name)));

ALTER TABLE doctors
ADD COLUMN IF NOT EXISTS specialty_id UUID REFERENCES specialties(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_doctors_specialty_id
ON doctors(specialty_id);
