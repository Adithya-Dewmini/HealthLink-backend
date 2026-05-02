CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users
  ALTER COLUMN password DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS is_password_set BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE users
SET
  password_hash = COALESCE(password_hash, password),
  is_password_set = CASE
    WHEN COALESCE(password_hash, password) IS NOT NULL THEN TRUE
    ELSE FALSE
  END
WHERE password_hash IS NULL
   OR is_password_set IS DISTINCT FROM CASE
     WHEN COALESCE(password_hash, password) IS NOT NULL THEN TRUE
     ELSE FALSE
   END;

CREATE TABLE IF NOT EXISTS password_setup_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  token_lookup_hash TEXT,
  expires_at TIMESTAMP NOT NULL,
  is_used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_user_id
  ON password_setup_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_lookup_hash
  ON password_setup_tokens(token_lookup_hash);

UPDATE password_setup_tokens
SET token_lookup_hash = encode(digest(token, 'sha256'), 'hex')
WHERE token_lookup_hash IS NULL
  AND token IS NOT NULL
  AND token NOT LIKE '$2a$%'
  AND token NOT LIKE '$2b$%'
  AND token NOT LIKE '$2y$%';

CREATE TABLE IF NOT EXISTS medical_center_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  medical_center_id UUID REFERENCES medical_centers(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, medical_center_id, role)
);

CREATE INDEX IF NOT EXISTS idx_medical_center_users_center_role
  ON medical_center_users(medical_center_id, role);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
