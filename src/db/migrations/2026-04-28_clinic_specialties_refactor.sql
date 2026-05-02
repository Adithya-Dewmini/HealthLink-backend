CREATE TABLE IF NOT EXISTS clinic_specialties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES medical_centers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_clinic_specialties_clinic_id
ON clinic_specialties(clinic_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_specialties_clinic_name_lower
ON clinic_specialties(clinic_id, LOWER(TRIM(name)));

ALTER TABLE medical_center_doctors
ADD COLUMN IF NOT EXISTS clinic_specialty_id UUID REFERENCES clinic_specialties(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_medical_center_doctors_clinic_specialty_id
ON medical_center_doctors(clinic_specialty_id);
