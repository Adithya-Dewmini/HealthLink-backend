ALTER TABLE patient_profiles ADD COLUMN IF NOT EXISTS expo_push_token TEXT;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS expo_push_token TEXT;
