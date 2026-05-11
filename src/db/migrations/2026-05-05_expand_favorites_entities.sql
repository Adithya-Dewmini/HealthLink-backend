ALTER TABLE favorites
  ALTER COLUMN item_id DROP NOT NULL;

ALTER TABLE favorites
  ADD COLUMN IF NOT EXISTS entity_id TEXT;

UPDATE favorites
SET entity_id = COALESCE(entity_id, item_id::text)
WHERE entity_id IS NULL;

ALTER TABLE favorites
  ALTER COLUMN entity_id SET NOT NULL;

ALTER TABLE favorites
  DROP CONSTRAINT IF EXISTS favorites_patient_id_item_id_item_type_key;

ALTER TABLE favorites
  DROP CONSTRAINT IF EXISTS favorites_item_type_check;

ALTER TABLE favorites
  ADD CONSTRAINT favorites_item_type_check
  CHECK (item_type IN ('pharmacy', 'doctor', 'medical_center'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_patient_entity_unique
ON favorites(patient_id, item_type, entity_id);
