ALTER TABLE audit_logs
ADD COLUMN IF NOT EXISTS actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS actor_role TEXT,
ADD COLUMN IF NOT EXISTS ip_address TEXT,
ADD COLUMN IF NOT EXISTS user_agent TEXT,
ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE audit_logs
SET actor_user_id = COALESCE(actor_user_id, actor_id, user_id)
WHERE actor_user_id IS NULL;

UPDATE audit_logs
SET metadata = COALESCE(metadata, notes, '{}'::jsonb)
WHERE metadata IS NULL OR metadata = '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_created
ON audit_logs (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_role_created
ON audit_logs (actor_role, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
ON audit_logs (action, created_at DESC);
