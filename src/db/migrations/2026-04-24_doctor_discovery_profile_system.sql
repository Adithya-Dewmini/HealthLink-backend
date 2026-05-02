ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS qualifications TEXT,
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS hospital_affiliations TEXT,
  ADD COLUMN IF NOT EXISTS consultation_fee NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS profile_image TEXT,
  ADD COLUMN IF NOT EXISTS languages TEXT;

CREATE TABLE IF NOT EXISTS doctor_profile_visibility (
  doctor_id INTEGER PRIMARY KEY REFERENCES doctors(id) ON DELETE CASCADE,
  visibility VARCHAR(20) NOT NULL DEFAULT 'PUBLIC',
  CONSTRAINT doctor_profile_visibility_check CHECK (UPPER(visibility) IN ('PUBLIC', 'PRIVATE'))
);

CREATE INDEX IF NOT EXISTS idx_doctors_specialization
  ON doctors (LOWER(COALESCE(specialization, '')));

CREATE INDEX IF NOT EXISTS idx_users_name_lower
  ON users (LOWER(COALESCE(name, '')));
