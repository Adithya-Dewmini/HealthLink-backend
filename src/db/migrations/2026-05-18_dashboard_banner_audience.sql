ALTER TABLE dashboard_banners
ADD COLUMN IF NOT EXISTS audience VARCHAR(40) NOT NULL DEFAULT 'patient';

UPDATE dashboard_banners
SET audience = 'patient'
WHERE audience IS NULL OR TRIM(audience) = '';

CREATE INDEX IF NOT EXISTS idx_dashboard_banners_audience_active
ON dashboard_banners (audience, is_active, sort_order, created_at DESC);
