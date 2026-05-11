CREATE TABLE IF NOT EXISTS marketplace_products (
  id BIGSERIAL PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  inventory_item_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  generic_name TEXT,
  brand TEXT,
  description TEXT,
  category TEXT,
  price NUMERIC(10,2) NOT NULL,
  discount_price NUMERIC(10,2),
  image_url TEXT,
  requires_prescription BOOLEAN NOT NULL DEFAULT FALSE,
  is_featured BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_products_pharmacy_inventory_unique
ON marketplace_products (pharmacy_id, inventory_item_id);

CREATE INDEX IF NOT EXISTS idx_marketplace_products_pharmacy_active
ON marketplace_products (pharmacy_id, is_active, is_featured, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_products_search
ON marketplace_products (
  LOWER(COALESCE(name, '')),
  LOWER(COALESCE(generic_name, '')),
  LOWER(COALESCE(brand, ''))
);
