ALTER TABLE orders
ADD COLUMN IF NOT EXISTS prescription_id UUID NULL REFERENCES prescriptions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_prescription_id
ON orders (prescription_id)
WHERE prescription_id IS NOT NULL;

ALTER TABLE order_items
ADD COLUMN IF NOT EXISTS substituted_inventory_item_id INTEGER NULL REFERENCES medicines(id) ON DELETE SET NULL;

ALTER TABLE order_items
ADD COLUMN IF NOT EXISTS substitution_approved BOOLEAN NOT NULL DEFAULT FALSE;
