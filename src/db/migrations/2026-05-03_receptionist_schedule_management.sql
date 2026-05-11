ALTER TABLE receptionist_permissions
ADD COLUMN IF NOT EXISTS schedule_management BOOLEAN NOT NULL DEFAULT FALSE;
