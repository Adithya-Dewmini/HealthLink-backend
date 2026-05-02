-- Add missed_at timestamps
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS missed_at TIMESTAMP;
ALTER TABLE queue_patients ADD COLUMN IF NOT EXISTS missed_at TIMESTAMP;
