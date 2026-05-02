CREATE TABLE IF NOT EXISTS receptionist_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medical_center_id UUID NOT NULL REFERENCES medical_centers(id) ON DELETE CASCADE,
  can_manage_queue BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_appointments BOOLEAN NOT NULL DEFAULT FALSE,
  can_check_in BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, medical_center_id)
);

CREATE INDEX IF NOT EXISTS idx_receptionist_permissions_center_user
  ON receptionist_permissions(medical_center_id, user_id);
