ALTER TABLE medical_centers
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verification_notes TEXT;

ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verification_notes TEXT;

ALTER TABLE pharmacies
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verification_notes TEXT;

CREATE TABLE IF NOT EXISTS verification_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS verification_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE verification_documents
  DROP CONSTRAINT IF EXISTS verification_documents_entity_type_check;

ALTER TABLE verification_documents
  ADD CONSTRAINT verification_documents_entity_type_check
  CHECK (LOWER(entity_type) IN ('clinic', 'doctor', 'pharmacy'));

ALTER TABLE verification_reviews
  DROP CONSTRAINT IF EXISTS verification_reviews_entity_type_check,
  DROP CONSTRAINT IF EXISTS verification_reviews_status_check;

ALTER TABLE verification_reviews
  ADD CONSTRAINT verification_reviews_entity_type_check
  CHECK (LOWER(entity_type) IN ('clinic', 'doctor', 'pharmacy')),
  ADD CONSTRAINT verification_reviews_status_check
  CHECK (LOWER(status) IN ('pending', 'approved', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_verification_documents_entity
  ON verification_documents(entity_type, entity_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_verification_reviews_entity
  ON verification_reviews(entity_type, entity_id, reviewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_verification_reviews_status
  ON verification_reviews(status, reviewed_at DESC);
