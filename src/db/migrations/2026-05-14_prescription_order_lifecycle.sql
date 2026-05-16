ALTER TABLE orders
ADD COLUMN IF NOT EXISTS order_code TEXT,
ADD COLUMN IF NOT EXISTS pharmacist_note TEXT,
ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

UPDATE orders
SET order_code = CONCAT('HL-', id)
WHERE order_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_code
ON orders (order_code)
WHERE order_code IS NOT NULL;

ALTER TABLE order_items
ADD COLUMN IF NOT EXISTS prescription_item_id INTEGER,
ADD COLUMN IF NOT EXISTS requested_quantity INTEGER,
ADD COLUMN IF NOT EXISTS approved_quantity INTEGER,
ADD COLUMN IF NOT EXISTS substitution_name TEXT,
ADD COLUMN IF NOT EXISTS note TEXT;

UPDATE order_items
SET requested_quantity = COALESCE(requested_quantity, quantity),
    approved_quantity = COALESCE(approved_quantity, quantity)
WHERE requested_quantity IS NULL
   OR approved_quantity IS NULL;

ALTER TABLE prescriptions
ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE prescription_items
ADD COLUMN IF NOT EXISTS matched_inventory_item_id INTEGER,
ADD COLUMN IF NOT EXISTS item_status TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS fulfilled_quantity INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS substitution_allowed BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE prescription_items
SET fulfilled_quantity = COALESCE(fulfilled_quantity, dispensed_quantity, 0)
WHERE fulfilled_quantity IS NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_prescription_item
ON order_items (prescription_item_id)
WHERE prescription_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_prescription_active
ON orders (prescription_id, status)
WHERE prescription_id IS NOT NULL;
