ALTER TABLE doctor_routines
  ADD COLUMN IF NOT EXISTS room_number VARCHAR(120);

ALTER TABLE medical_center_doctor_schedule
  ADD COLUMN IF NOT EXISTS room_number VARCHAR(120);
