CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS dashboard_banners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255),
  subtitle TEXT,
  image_url TEXT NOT NULL,
  target_type VARCHAR(80),
  target_id TEXT,
  target_screen VARCHAR(120),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE dashboard_banners ALTER COLUMN title DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dashboard_banners_patient_active
ON dashboard_banners (is_active, sort_order, created_at DESC);
