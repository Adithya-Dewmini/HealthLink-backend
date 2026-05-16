import { Pool } from "pg";
import { env } from "./env";
import {
  BOOKING_STATUS,
  DEFAULT_BOOKING_GRACE_PERIOD_MINUTES,
  normalizeBookingStatus,
} from "../utils/bookingLifecycle";

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.pgSsl
    ? {
        rejectUnauthorized: false,
      }
    : false,
  max: env.pgPoolMax,
  min: env.pgPoolMin,
  idleTimeoutMillis: env.pgIdleTimeoutMs,
  connectionTimeoutMillis: env.pgConnectTimeoutMs,
});

pool.on("error", (err: Error) => {
  console.error("Unexpected DB error", err);
});

const poolDebugTimer = setInterval(() => {
  console.log({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  });
}, 5000);

poolDebugTimer.unref?.();

const INIT_DB_ADVISORY_LOCK_KEY = 814205631;
const INIT_DB_MAX_ATTEMPTS = 4;
const INIT_DB_RETRY_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableInitDbError = (error: unknown) => {
  const code = String((error as { code?: string } | undefined)?.code || "");
  return code === "40P01" || code === "55P03";
};

export const verifyDbConnection = async () => {
  await pool.query("SELECT 1");
  console.log("✅ DB connected");
};

const initDbOnce = async () => {
  await verifyDbConnection();
  const client = await pool.connect();
  let advisoryLockHeld = false;
  let sessionTimeoutsConfigured = false;

  try {
    // Serialize schema bootstrap across concurrent app instances to avoid DDL deadlocks.
    await client.query("SELECT pg_advisory_lock($1)", [INIT_DB_ADVISORY_LOCK_KEY]);
    advisoryLockHeld = true;

    // Fail fast if the DB is unreachable instead of hanging. Reset these before releasing
    // the pooled client so the limits do not leak into normal request traffic.
    await client.query("SET statement_timeout = 10000");
    await client.query("SET lock_timeout = 5000");
    sessionTimeoutsConfigured = true;

    // Keep bootstrap idempotent and autocommitted instead of holding one massive transaction.
    // The previous transaction accumulated AccessExclusive locks across many tables, which made
    // startup prone to deadlocks with ordinary read traffic on older tables.
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT,
        password_hash TEXT,
        is_password_set BOOLEAN NOT NULL DEFAULT FALSE,
        role TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.users') IS NOT NULL THEN
          ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
          ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
          ALTER TABLE users ADD COLUMN IF NOT EXISTS is_password_set BOOLEAN NOT NULL DEFAULT FALSE;
          ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image TEXT;
          ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image_id TEXT;
        END IF;
      END $$;
    `);

    await client.query(`
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
         END
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS medical_centers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        address TEXT,
        city TEXT,
        phone VARCHAR(20),
        email VARCHAR(255),
        admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(20) DEFAULT 'ACTIVE',
        verification_status TEXT NOT NULL DEFAULT 'pending',
        verified_at TIMESTAMP,
        verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        verification_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.medical_centers') IS NOT NULL THEN
          ALTER TABLE medical_centers ADD COLUMN IF NOT EXISTS admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
          ALTER TABLE medical_centers ADD COLUMN IF NOT EXISTS city TEXT;
          ALTER TABLE medical_centers ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending';
          ALTER TABLE medical_centers ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;
          ALTER TABLE medical_centers ADD COLUMN IF NOT EXISTS verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
          ALTER TABLE medical_centers ADD COLUMN IF NOT EXISTS verification_notes TEXT;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS medical_center_admins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        medical_center_id UUID REFERENCES medical_centers(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id),
        UNIQUE (user_id, medical_center_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS medical_center_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        medical_center_id UUID REFERENCES medical_centers(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, medical_center_id, role)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS clinic_specialties (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        clinic_id UUID NOT NULL REFERENCES medical_centers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS specialties (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_specialties_name_lower
      ON specialties(LOWER(TRIM(name)))
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_clinic_specialties_clinic_id
      ON clinic_specialties(clinic_id)
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_specialties_clinic_name_lower
      ON clinic_specialties(clinic_id, LOWER(TRIM(name)))
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_setup_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        token_lookup_hash TEXT,
        expires_at TIMESTAMP NOT NULL,
        is_used BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.password_setup_tokens') IS NOT NULL THEN
          ALTER TABLE password_setup_tokens ADD COLUMN IF NOT EXISTS token_lookup_hash TEXT;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_lookup_hash
      ON password_setup_tokens(token_lookup_hash)
    `);

    await client.query(`
      UPDATE password_setup_tokens
      SET token_lookup_hash = encode(digest(token, 'sha256'), 'hex')
      WHERE token_lookup_hash IS NULL
        AND token IS NOT NULL
        AND token NOT LIKE '$2a$%'
        AND token NOT LIKE '$2b$%'
        AND token NOT LIKE '$2y$%'
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_user_id
      ON password_setup_tokens(user_id)
    `);

    await client.query(`
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
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.dashboard_banners') IS NOT NULL THEN
          ALTER TABLE dashboard_banners ALTER COLUMN title DROP NOT NULL;
          ALTER TABLE dashboard_banners ADD COLUMN IF NOT EXISTS subtitle TEXT;
          ALTER TABLE dashboard_banners ADD COLUMN IF NOT EXISTS target_type VARCHAR(80);
          ALTER TABLE dashboard_banners ADD COLUMN IF NOT EXISTS target_id TEXT;
          ALTER TABLE dashboard_banners ADD COLUMN IF NOT EXISTS target_screen VARCHAR(120);
          ALTER TABLE dashboard_banners ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
          ALTER TABLE dashboard_banners ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE dashboard_banners ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ;
          ALTER TABLE dashboard_banners ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ;
          ALTER TABLE dashboard_banners ADD COLUMN IF NOT EXISTS created_by UUID;
          ALTER TABLE dashboard_banners ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
          ALTER TABLE dashboard_banners ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dashboard_banners_patient_active
      ON dashboard_banners (is_active, sort_order, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_medical_center_users_center_role
      ON medical_center_users(medical_center_id, role)
    `);

    await client.query(`
      UPDATE medical_centers mc
      SET admin_id = sub.user_id
      FROM (
        SELECT DISTINCT ON (medical_center_id) medical_center_id, user_id
        FROM medical_center_admins
        ORDER BY medical_center_id, created_at ASC
      ) sub
      WHERE mc.id = sub.medical_center_id
        AND mc.admin_id IS NULL
    `);

    await client.query(`
      DO $$
      BEGIN
        CREATE TYPE doctor_relationship_status AS ENUM ('PENDING', 'ACTIVE', 'INACTIVE', 'REJECTED');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        CREATE TYPE doctor_invite_status AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        CREATE TYPE doctor_join_request_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS medical_center_doctors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        medical_center_id UUID NOT NULL REFERENCES medical_centers(id) ON DELETE CASCADE,
        doctor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        clinic_specialty_id UUID REFERENCES clinic_specialties(id) ON DELETE SET NULL,
        status doctor_relationship_status NOT NULL DEFAULT 'PENDING',
        is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
        is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (medical_center_id, doctor_id)
      )
    `);

    await client.query(`
      ALTER TABLE IF EXISTS medical_center_doctors
      ADD COLUMN IF NOT EXISTS clinic_specialty_id UUID REFERENCES clinic_specialties(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_medical_center_doctors_center_status
      ON medical_center_doctors(medical_center_id, status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_medical_center_doctors_doctor_status
      ON medical_center_doctors(doctor_id, status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_medical_center_doctors_clinic_specialty_id
      ON medical_center_doctors(clinic_specialty_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_invites (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        medical_center_id UUID NOT NULL REFERENCES medical_centers(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        token TEXT NOT NULL,
        status doctor_invite_status NOT NULL DEFAULT 'PENDING',
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctor_invites_center_email_status
      ON doctor_invites(medical_center_id, email, status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctor_invites_token
      ON doctor_invites(token)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_join_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        medical_center_id UUID NOT NULL REFERENCES medical_centers(id) ON DELETE CASCADE,
        status doctor_join_request_status NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (doctor_id, medical_center_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctor_join_requests_center_status
      ON doctor_join_requests(medical_center_id, status)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS receptionist_permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        medical_center_id UUID NOT NULL REFERENCES medical_centers(id) ON DELETE CASCADE,
        can_manage_queue BOOLEAN NOT NULL DEFAULT FALSE,
        can_manage_appointments BOOLEAN NOT NULL DEFAULT FALSE,
        can_check_in BOOLEAN NOT NULL DEFAULT FALSE,
        schedule_management BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, medical_center_id)
      )
    `);

    await client.query(`
      ALTER TABLE IF EXISTS receptionist_permissions
      ADD COLUMN IF NOT EXISTS schedule_management BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_receptionist_permissions_center_user
      ON receptionist_permissions(medical_center_id, user_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        notes JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      ALTER TABLE IF EXISTS audit_logs
      ADD COLUMN IF NOT EXISTS actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS actor_role TEXT,
      ADD COLUMN IF NOT EXISTS entity_type TEXT,
      ADD COLUMN IF NOT EXISTS entity_id TEXT,
      ADD COLUMN IF NOT EXISTS notes JSONB,
      ADD COLUMN IF NOT EXISTS ip_address TEXT,
      ADD COLUMN IF NOT EXISTS user_agent TEXT,
      ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);

    await client.query(`
      UPDATE audit_logs
      SET
        actor_id = COALESCE(actor_id, user_id),
        actor_user_id = COALESCE(actor_user_id, actor_id, user_id),
        metadata = COALESCE(metadata, notes, '{}'::jsonb)
      WHERE actor_id IS NULL
         OR actor_user_id IS NULL
         OR metadata IS NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id
      ON audit_logs (actor_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_type_id
      ON audit_logs (entity_type, entity_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_created
      ON audit_logs (actor_user_id, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_role_created
      ON audit_logs (actor_role, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
      ON audit_logs (action, created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS doctors (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        phone TEXT,
        nic TEXT,
        specialization TEXT,
        specialty_id UUID REFERENCES specialties(id) ON DELETE SET NULL,
        license_number TEXT,
        slmc_number TEXT,
        experience_years INTEGER,
        qualifications TEXT,
        bio TEXT,
        hospital_affiliations TEXT,
        consultation_fee NUMERIC(10,2),
        profile_image TEXT,
        languages TEXT,
        workplace TEXT,
        medical_center_id UUID REFERENCES medical_centers(id) ON DELETE SET NULL,
        verification_status TEXT NOT NULL DEFAULT 'pending',
        verified_at TIMESTAMP,
        verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        verification_notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.doctors') IS NOT NULL THEN
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS phone TEXT;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS nic TEXT;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS specialization TEXT;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS specialty_id UUID REFERENCES specialties(id) ON DELETE SET NULL;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS license_number TEXT;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS slmc_number TEXT;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS experience_years INTEGER;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS qualifications TEXT;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS bio TEXT;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS hospital_affiliations TEXT;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS consultation_fee NUMERIC(10,2);
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS profile_image TEXT;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS languages TEXT;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS workplace TEXT;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS medical_center_id UUID REFERENCES medical_centers(id) ON DELETE SET NULL;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending';
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS verification_notes TEXT;
          ALTER TABLE doctors ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      UPDATE doctors
      SET slmc_number = COALESCE(NULLIF(TRIM(slmc_number), ''), NULLIF(TRIM(license_number), ''))
      WHERE COALESCE(NULLIF(TRIM(slmc_number), ''), '') = ''
        AND COALESCE(NULLIF(TRIM(license_number), ''), '') <> ''
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_profile_visibility (
        doctor_id INTEGER PRIMARY KEY REFERENCES doctors(id) ON DELETE CASCADE,
        visibility VARCHAR(20) NOT NULL DEFAULT 'PUBLIC'
      )
    `);

    await client.query(`
      ALTER TABLE IF EXISTS doctor_profile_visibility
      DROP CONSTRAINT IF EXISTS doctor_profile_visibility_check;
    `);

    await client.query(`
      ALTER TABLE IF EXISTS doctor_profile_visibility
      ADD CONSTRAINT doctor_profile_visibility_check
      CHECK (UPPER(visibility) IN ('PUBLIC', 'PRIVATE'));
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctors_specialization
      ON doctors (LOWER(COALESCE(specialization, '')));
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_doctors_slmc_number_lower
      ON doctors (LOWER(TRIM(slmc_number)))
      WHERE slmc_number IS NOT NULL AND TRIM(slmc_number) <> ''
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctors_nic_lower
      ON doctors (LOWER(TRIM(nic)))
      WHERE nic IS NOT NULL AND TRIM(nic) <> ''
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctors_specialty_id
      ON doctors (specialty_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
        slmc_certificate_url TEXT NOT NULL,
        degree_certificate_url TEXT NOT NULL,
        id_proof_url TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (doctor_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_verifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
        verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        notes TEXT,
        verified_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE doctor_verifications
      DROP CONSTRAINT IF EXISTS doctor_verifications_status_check
    `);

    await client.query(`
      ALTER TABLE doctor_verifications
      ADD CONSTRAINT doctor_verifications_status_check
      CHECK (LOWER(status) IN ('pending', 'verified', 'rejected'))
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctor_verifications_doctor_id
      ON doctor_verifications (doctor_id, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctor_verifications_status
      ON doctor_verifications (status, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_name_lower
      ON users (LOWER(COALESCE(name, '')));
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS receptionists (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        phone TEXT,
        medical_center_id UUID REFERENCES medical_centers(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.receptionists') IS NOT NULL THEN
          ALTER TABLE receptionists ADD COLUMN IF NOT EXISTS phone TEXT;
          ALTER TABLE receptionists ADD COLUMN IF NOT EXISTS medical_center_id UUID REFERENCES medical_centers(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pharmacies (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        location TEXT,
        phone TEXT,
        email TEXT,
        image_url TEXT,
        rating NUMERIC(3,1),
        status TEXT,
        verification_status TEXT NOT NULL DEFAULT 'pending',
        verified_at TIMESTAMP,
        verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        verification_notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.pharmacies') IS NOT NULL THEN
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS location TEXT;
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS phone TEXT;
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS email TEXT;
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS image_url TEXT;
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS logo_url TEXT;
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS logo_id TEXT;
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS cover_id TEXT;
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS rating NUMERIC(3,1);
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS status TEXT;
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending';
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
          ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS verification_notes TEXT;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pharmacist_pharmacies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, pharmacy_id)
      )
    `);

    await client.query(`
      INSERT INTO pharmacies (id, name, location, image_url, rating, status)
      VALUES
        (1, 'Lanka Pharmacy - Central', 'Colombo', 'https://images.unsplash.com/photo-1587854692152-cbe660dbbb88?q=80&w=1000&auto=format&fit=crop', 4.8, 'Open Now'),
        (2, 'MediHelp Wellness Center', 'Kandy', 'https://images.unsplash.com/photo-1631549916768-4119b2e5f926?q=80&w=1000&auto=format&fit=crop', 4.5, 'Open Now'),
        (3, 'City Care Healthcare', 'Galle', 'https://images.unsplash.com/photo-1576602976047-174e57a47881?q=80&w=1000&auto=format&fit=crop', 4.2, 'Closing Soon')
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        location = EXCLUDED.location,
        image_url = EXCLUDED.image_url,
        rating = EXCLUDED.rating,
        status = EXCLUDED.status
    `);

    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('pharmacies', 'id'),
        GREATEST(COALESCE((SELECT MAX(id) FROM pharmacies), 0), 1),
        true
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS verification_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        document_type TEXT NOT NULL,
        file_url TEXT NOT NULL,
        uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS verification_reviews (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.verification_documents') IS NOT NULL THEN
          ALTER TABLE verification_documents ADD COLUMN IF NOT EXISTS entity_type TEXT;
          ALTER TABLE verification_documents ADD COLUMN IF NOT EXISTS entity_id TEXT;
          ALTER TABLE verification_documents ADD COLUMN IF NOT EXISTS document_type TEXT;
          ALTER TABLE verification_documents ADD COLUMN IF NOT EXISTS file_url TEXT;
          ALTER TABLE verification_documents ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.verification_reviews') IS NOT NULL THEN
          ALTER TABLE verification_reviews ADD COLUMN IF NOT EXISTS entity_type TEXT;
          ALTER TABLE verification_reviews ADD COLUMN IF NOT EXISTS entity_id TEXT;
          ALTER TABLE verification_reviews ADD COLUMN IF NOT EXISTS status TEXT;
          ALTER TABLE verification_reviews ADD COLUMN IF NOT EXISTS note TEXT;
          ALTER TABLE verification_reviews ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
          ALTER TABLE verification_reviews ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'verification_documents'
            AND column_name = 'entity_id'
            AND udt_name <> 'text'
        ) THEN
          ALTER TABLE verification_documents
          ALTER COLUMN entity_id TYPE TEXT USING entity_id::text;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'verification_reviews'
            AND column_name = 'entity_id'
            AND udt_name <> 'text'
        ) THEN
          ALTER TABLE verification_reviews
          ALTER COLUMN entity_id TYPE TEXT USING entity_id::text;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'medical_centers'
            AND column_name = 'verified_by'
            AND udt_name <> 'int4'
        ) THEN
          ALTER TABLE medical_centers DROP CONSTRAINT IF EXISTS medical_centers_verified_by_fkey;
          ALTER TABLE medical_centers
          ALTER COLUMN verified_by TYPE INTEGER USING NULLIF(verified_by::text, '')::integer;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'doctors'
            AND column_name = 'verified_by'
            AND udt_name <> 'int4'
        ) THEN
          ALTER TABLE doctors DROP CONSTRAINT IF EXISTS doctors_verified_by_fkey;
          ALTER TABLE doctors
          ALTER COLUMN verified_by TYPE INTEGER USING NULLIF(verified_by::text, '')::integer;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'pharmacies'
            AND column_name = 'verified_by'
            AND udt_name <> 'int4'
        ) THEN
          ALTER TABLE pharmacies DROP CONSTRAINT IF EXISTS pharmacies_verified_by_fkey;
          ALTER TABLE pharmacies
          ALTER COLUMN verified_by TYPE INTEGER USING NULLIF(verified_by::text, '')::integer;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'verification_reviews'
            AND column_name = 'reviewed_by'
            AND udt_name <> 'int4'
        ) THEN
          ALTER TABLE verification_reviews DROP CONSTRAINT IF EXISTS verification_reviews_reviewed_by_fkey;
          ALTER TABLE verification_reviews
          ALTER COLUMN reviewed_by TYPE INTEGER USING NULLIF(reviewed_by::text, '')::integer;
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'medical_centers_verified_by_fkey'
            AND conrelid = 'public.medical_centers'::regclass
        ) THEN
          ALTER TABLE medical_centers
          ADD CONSTRAINT medical_centers_verified_by_fkey
          FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'doctors_verified_by_fkey'
            AND conrelid = 'public.doctors'::regclass
        ) THEN
          ALTER TABLE doctors
          ADD CONSTRAINT doctors_verified_by_fkey
          FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'pharmacies_verified_by_fkey'
            AND conrelid = 'public.pharmacies'::regclass
        ) THEN
          ALTER TABLE pharmacies
          ADD CONSTRAINT pharmacies_verified_by_fkey
          FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'verification_reviews_reviewed_by_fkey'
            AND conrelid = 'public.verification_reviews'::regclass
        ) THEN
          ALTER TABLE verification_reviews
          ADD CONSTRAINT verification_reviews_reviewed_by_fkey
          FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await client.query(`
      UPDATE verification_documents
      SET uploaded_at = COALESCE(uploaded_at, created_at, CURRENT_TIMESTAMP)
      WHERE uploaded_at IS NULL
    `);

    await client.query(`
      UPDATE verification_reviews
      SET reviewed_at = COALESCE(reviewed_at, created_at, CURRENT_TIMESTAMP)
      WHERE reviewed_at IS NULL
    `);

    await client.query(`
      ALTER TABLE verification_documents
      DROP CONSTRAINT IF EXISTS verification_documents_entity_type_check
    `);

    await client.query(`
      ALTER TABLE verification_reviews
      DROP CONSTRAINT IF EXISTS verification_reviews_entity_type_check
    `);

    await client.query(`
      ALTER TABLE verification_reviews
      DROP CONSTRAINT IF EXISTS verification_reviews_status_check
    `);

    await client.query(`
      ALTER TABLE verification_documents
      ADD CONSTRAINT verification_documents_entity_type_check
      CHECK (LOWER(entity_type) IN ('clinic', 'doctor', 'pharmacy'))
    `);

    await client.query(`
      ALTER TABLE verification_reviews
      ADD CONSTRAINT verification_reviews_entity_type_check
      CHECK (LOWER(entity_type) IN ('clinic', 'doctor', 'pharmacy'))
    `);

    await client.query(`
      ALTER TABLE verification_reviews
      ADD CONSTRAINT verification_reviews_status_check
      CHECK (LOWER(status) IN ('pending', 'approved', 'rejected'))
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_verification_documents_entity
      ON verification_documents(entity_type, entity_id, uploaded_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_verification_reviews_entity
      ON verification_reviews(entity_type, entity_id, reviewed_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_verification_reviews_status
      ON verification_reviews(status, reviewed_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_medical_centers_verification_status
      ON medical_centers(verification_status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctors_verification_status
      ON doctors(verification_status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pharmacies_verification_status
      ON pharmacies(verification_status)
    `);

    await client.query(`
      UPDATE medical_centers
      SET verification_status = 'approved'
      WHERE verification_status IS NULL
         OR verification_status = ''
    `);

    await client.query(`
      UPDATE medical_centers
      SET verification_status = 'approved'
      WHERE LOWER(COALESCE(status, '')) = 'approved'
        AND LOWER(COALESCE(verification_status, 'pending')) <> 'approved'
    `);

    await client.query(`
      UPDATE medical_centers
      SET status = 'ACTIVE'
      WHERE LOWER(COALESCE(verification_status, 'pending')) = 'approved'
        AND LOWER(COALESCE(status, '')) = 'approved'
    `);

    await client.query(`
      UPDATE doctors
      SET verification_status = 'approved'
      WHERE verification_status IS NULL
         OR verification_status = ''
    `);

    await client.query(`
      UPDATE pharmacies
      SET verification_status = 'approved'
      WHERE verification_status IS NULL
         OR verification_status = ''
    `);

    await client.query(`
      UPDATE pharmacies
      SET status = 'ACTIVE'
      WHERE LOWER(COALESCE(verification_status, 'pending')) = 'approved'
        AND LOWER(COALESCE(status, '')) IN ('', 'inactive', 'pending', 'approved')
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS favorites (
        id SERIAL PRIMARY KEY,
        patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id INTEGER,
        entity_id TEXT NOT NULL,
        item_type TEXT NOT NULL CHECK (item_type IN ('pharmacy', 'doctor', 'medical_center')),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (patient_id, item_type, entity_id)
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.favorites') IS NOT NULL THEN
          ALTER TABLE favorites ALTER COLUMN item_id DROP NOT NULL;
          ALTER TABLE favorites ADD COLUMN IF NOT EXISTS entity_id TEXT;

          UPDATE favorites
          SET entity_id = COALESCE(entity_id, item_id::text)
          WHERE entity_id IS NULL;

          ALTER TABLE favorites ALTER COLUMN entity_id SET NOT NULL;

          ALTER TABLE favorites DROP CONSTRAINT IF EXISTS favorites_patient_id_item_id_item_type_key;
          ALTER TABLE favorites DROP CONSTRAINT IF EXISTS favorites_item_type_check;
          ALTER TABLE favorites
            ADD CONSTRAINT favorites_item_type_check
            CHECK (item_type IN ('pharmacy', 'doctor', 'medical_center'));
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_patient_entity_unique
      ON favorites(patient_id, item_type, entity_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS patient_profiles (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        phone TEXT,
        dob DATE,
        gender TEXT,
        blood_group TEXT,
        allergies TEXT,
        conditions TEXT,
        emergency_name TEXT,
        emergency_phone TEXT,
        nic TEXT,
        address TEXT,
        city TEXT,
        expo_push_token TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.patient_profiles') IS NOT NULL THEN
          ALTER TABLE patient_profiles ADD COLUMN IF NOT EXISTS expo_push_token TEXT;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        age INTEGER,
        gender TEXT,
        contact_number TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.doctors') IS NOT NULL THEN
          CREATE TABLE IF NOT EXISTS doctor_availability (
            id SERIAL PRIMARY KEY,
            doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
            day TEXT NOT NULL,
            day_of_week INTEGER,
            start_time TIME NOT NULL,
            end_time TIME NOT NULL,
            max_patients INTEGER,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
          );
          ALTER TABLE doctor_availability
          ADD COLUMN IF NOT EXISTS max_patients INTEGER,
          ADD COLUMN IF NOT EXISTS day_of_week INTEGER,
          ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

          IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'doctor_availability'
              AND column_name = 'start'
          ) AND NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'doctor_availability'
              AND column_name = 'start_time'
          ) THEN
            ALTER TABLE doctor_availability RENAME COLUMN start TO start_time;
          END IF;

          IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'doctor_availability'
              AND column_name = 'end'
          ) AND NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'doctor_availability'
              AND column_name = 'end_time'
          ) THEN
            ALTER TABLE doctor_availability RENAME COLUMN "end" TO end_time;
          END IF;
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.doctors') IS NOT NULL THEN
          CREATE TABLE IF NOT EXISTS doctor_working_days (
            id SERIAL PRIMARY KEY,
            doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
            day VARCHAR(10) NOT NULL,
            UNIQUE (doctor_id, day)
          );
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.doctors') IS NOT NULL
           AND to_regclass('public.medical_centers') IS NOT NULL THEN
          CREATE TABLE IF NOT EXISTS doctor_routines (
            id SERIAL PRIMARY KEY,
            doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
            clinic_id UUID NOT NULL REFERENCES medical_centers(id) ON DELETE CASCADE,
            day_of_week INTEGER NOT NULL,
            start_time TIME NOT NULL,
            end_time TIME NOT NULL,
            room_number VARCHAR(120),
            slot_duration INTEGER NOT NULL DEFAULT 15,
            max_patients INTEGER NOT NULL DEFAULT 12,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
          );

          ALTER TABLE doctor_routines
          ADD COLUMN IF NOT EXISTS room_number VARCHAR(120),
          ADD COLUMN IF NOT EXISTS slot_duration INTEGER NOT NULL DEFAULT 15,
          ADD COLUMN IF NOT EXISTS max_patients INTEGER NOT NULL DEFAULT 12,
          ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
          ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(),
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.doctor_routines') IS NOT NULL THEN
          ALTER TABLE doctor_routines
          DROP CONSTRAINT IF EXISTS doctor_routines_day_of_week_check;

          ALTER TABLE doctor_routines
          ADD CONSTRAINT doctor_routines_day_of_week_check
          CHECK (day_of_week BETWEEN 0 AND 6);

          ALTER TABLE doctor_routines
          DROP CONSTRAINT IF EXISTS doctor_routines_time_range_check;

          ALTER TABLE doctor_routines
          ADD CONSTRAINT doctor_routines_time_range_check
          CHECK (start_time < end_time);

          ALTER TABLE doctor_routines
          DROP CONSTRAINT IF EXISTS doctor_routines_slot_duration_check;

          ALTER TABLE doctor_routines
          ADD CONSTRAINT doctor_routines_slot_duration_check
          CHECK (slot_duration > 0);

          ALTER TABLE doctor_routines
          DROP CONSTRAINT IF EXISTS doctor_routines_max_patients_check;

          ALTER TABLE doctor_routines
          ADD CONSTRAINT doctor_routines_max_patients_check
          CHECK (max_patients > 0);
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        CREATE TYPE doctor_session_source AS ENUM ('routine', 'manual');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        ALTER TYPE doctor_session_source ADD VALUE IF NOT EXISTS 'external';
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        CREATE TYPE doctor_session_mode AS ENUM ('QUEUE', 'APPOINTMENT', 'HYBRID');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctor_routines_doctor_day
      ON doctor_routines(doctor_id, day_of_week, is_active)
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.doctors') IS NOT NULL AND to_regclass('public.users') IS NOT NULL THEN
          CREATE TABLE IF NOT EXISTS bookings (
            id SERIAL PRIMARY KEY,
            doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
            patient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            date DATE NOT NULL,
            time TIME NOT NULL,
            status VARCHAR(20) DEFAULT 'BOOKED',
            scheduled_at TIMESTAMP,
            started_at TIMESTAMP,
            ended_at TIMESTAMP,
            grace_period_minutes INTEGER DEFAULT 15,
            created_at TIMESTAMP DEFAULT NOW(),
            missed_at TIMESTAMP
          );
          DROP INDEX IF EXISTS bookings_unique_slot;
          CREATE UNIQUE INDEX IF NOT EXISTS bookings_unique_slot
            ON bookings (doctor_id, date, time)
            WHERE COALESCE(UPPER(status), '') <> 'CANCELLED';
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      DECLARE constraint_name text;
      BEGIN
        SELECT conname INTO constraint_name
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        WHERE t.relname = 'doctor_availability'
          AND c.contype = 'u'
          AND pg_get_constraintdef(c.oid) LIKE '%(doctor_id, day)%'
        LIMIT 1;

        IF constraint_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE doctor_availability DROP CONSTRAINT %I', constraint_name);
        END IF;
      END $$;
    `);

    await client.query(`
      UPDATE doctor_availability
      SET day_of_week = CASE day
        WHEN 'Sunday' THEN 0
        WHEN 'Monday' THEN 1
        WHEN 'Tuesday' THEN 2
        WHEN 'Wednesday' THEN 3
        WHEN 'Thursday' THEN 4
        WHEN 'Friday' THEN 5
        WHEN 'Saturday' THEN 6
        ELSE day_of_week
      END
      WHERE day_of_week IS NULL;
    `);

    await client.query(`
      ALTER TABLE IF EXISTS medical_centers
      ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'PRIVATE';
    `);

    await client.query(`
      ALTER TABLE IF EXISTS medical_centers
      ADD COLUMN IF NOT EXISTS city TEXT,
      ADD COLUMN IF NOT EXISTS image_url TEXT,
      ADD COLUMN IF NOT EXISTS logo_url TEXT,
      ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
      ADD COLUMN IF NOT EXISTS logo_id TEXT,
      ADD COLUMN IF NOT EXISTS cover_id TEXT,
      ADD COLUMN IF NOT EXISTS opening_time TIME DEFAULT '08:00',
      ADD COLUMN IF NOT EXISTS closing_time TIME DEFAULT '20:00',
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.medical_center_doctors') IS NOT NULL THEN
          CREATE TABLE IF NOT EXISTS medical_center_doctor_schedule (
            id SERIAL PRIMARY KEY,
            medical_center_id UUID NOT NULL REFERENCES medical_centers(id) ON DELETE CASCADE,
            doctor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            doctor_profile_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
            date DATE NOT NULL,
            start_time TIME NOT NULL,
            end_time TIME NOT NULL,
            room_number VARCHAR(120),
            slot_duration INTEGER NOT NULL,
            max_patients INTEGER NOT NULL,
            routine_id INTEGER REFERENCES doctor_routines(id) ON DELETE SET NULL,
            source doctor_session_source NOT NULL DEFAULT 'manual',
            mode doctor_session_mode NOT NULL DEFAULT 'HYBRID',
            status VARCHAR(20) DEFAULT 'NOT_STARTED',
            is_active BOOLEAN DEFAULT TRUE,
            invalid_reason TEXT,
            invalidated_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
          );

          CREATE INDEX IF NOT EXISTS idx_center_schedule_center_date
            ON medical_center_doctor_schedule (medical_center_id, date);

          CREATE INDEX IF NOT EXISTS idx_center_schedule_doctor_date
            ON medical_center_doctor_schedule (doctor_user_id, date);
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_schedule_exceptions (
        id SERIAL PRIMARY KEY,
        schedule_id INTEGER NOT NULL REFERENCES medical_center_doctor_schedule(id) ON DELETE CASCADE,
        type VARCHAR(20) NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE IF EXISTS doctor_schedule_exceptions
      DROP CONSTRAINT IF EXISTS doctor_schedule_exceptions_type_check;
    `);

    await client.query(`
      ALTER TABLE IF EXISTS doctor_schedule_exceptions
      ADD CONSTRAINT doctor_schedule_exceptions_type_check
      CHECK (UPPER(type) IN ('BREAK', 'BLOCK', 'OVERRIDE'));
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_external_sessions (
        id SERIAL PRIMARY KEY,
        doctor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        clinic_name TEXT NOT NULL,
        note TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT doctor_external_sessions_day_check CHECK (day_of_week BETWEEN 0 AND 6),
        CONSTRAINT doctor_external_sessions_range_check CHECK (start_time < end_time)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctor_external_sessions_doctor_day
      ON doctor_external_sessions (doctor_user_id, day_of_week, is_active);
    `);

    await client.query(`
      ALTER TABLE IF EXISTS medical_center_doctor_schedule
      ADD COLUMN IF NOT EXISTS room_number VARCHAR(120),
      ADD COLUMN IF NOT EXISTS routine_id INTEGER REFERENCES doctor_routines(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS source doctor_session_source DEFAULT 'manual',
      ADD COLUMN IF NOT EXISTS mode doctor_session_mode DEFAULT 'HYBRID',
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'NOT_STARTED';
    `);

    await client.query(`
      UPDATE medical_center_doctor_schedule
      SET source = COALESCE(source, 'manual'::doctor_session_source)
      WHERE source IS NULL;
    `);

    await client.query(`
      UPDATE medical_center_doctor_schedule
      SET mode = COALESCE(mode, 'HYBRID'::doctor_session_mode)
      WHERE mode IS NULL;
    `);

    await client.query(`
      UPDATE medical_center_doctor_schedule
      SET status = CASE
        WHEN UPPER(COALESCE(status, '')) IN ('UPCOMING', 'NOT_STARTED') THEN 'NOT_STARTED'
        WHEN UPPER(COALESCE(status, '')) IN ('ACTIVE', 'LIVE') THEN 'LIVE'
        WHEN UPPER(COALESCE(status, '')) IN ('COMPLETED', 'CLOSED') THEN 'CLOSED'
        WHEN is_active = FALSE THEN 'CLOSED'
        ELSE 'NOT_STARTED'
      END
      WHERE status IS NULL
         OR UPPER(COALESCE(status, '')) NOT IN ('NOT_STARTED', 'LIVE', 'CLOSED');
    `);

    await client.query(`
      ALTER TABLE IF EXISTS medical_center_doctor_schedule
      DROP CONSTRAINT IF EXISTS medical_center_doctor_schedule_valid_range_check,
      DROP CONSTRAINT IF EXISTS medical_center_doctor_schedule_slot_duration_check,
      DROP CONSTRAINT IF EXISTS medical_center_doctor_schedule_max_patients_check;
    `);

    await client.query(`
      ALTER TABLE IF EXISTS medical_center_doctor_schedule
      ADD CONSTRAINT medical_center_doctor_schedule_valid_range_check
        CHECK (start_time < end_time),
      ADD CONSTRAINT medical_center_doctor_schedule_slot_duration_check
        CHECK (slot_duration > 0),
      ADD CONSTRAINT medical_center_doctor_schedule_max_patients_check
        CHECK (max_patients > 0);
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_center_schedule_unique_session
      ON medical_center_doctor_schedule (doctor_user_id, medical_center_id, date, start_time);
    `);

    await client.query(`
      ALTER TABLE IF EXISTS bookings
      ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES medical_center_doctor_schedule(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS started_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS grace_period_minutes INTEGER DEFAULT ${DEFAULT_BOOKING_GRACE_PERIOD_MINUTES},
      ADD COLUMN IF NOT EXISTS missed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS medical_center_id UUID REFERENCES medical_centers(id) ON DELETE CASCADE;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS bookings_unique_patient_session
      ON bookings (patient_id, session_id)
      WHERE session_id IS NOT NULL
        AND COALESCE(UPPER(status), '') <> '${BOOKING_STATUS.CANCELLED}';
    `);

    await client.query(`
      UPDATE bookings
      SET scheduled_at = COALESCE(scheduled_at, ((date::timestamp) + time)),
          grace_period_minutes = COALESCE(grace_period_minutes, ${DEFAULT_BOOKING_GRACE_PERIOD_MINUTES})
      WHERE scheduled_at IS NULL
         OR grace_period_minutes IS NULL;
    `);

    await client.query(`
      UPDATE bookings b
      SET session_id = s.id
      FROM medical_center_doctor_schedule s
      WHERE b.session_id IS NULL
        AND b.doctor_id = s.doctor_profile_id
        AND b.medical_center_id = s.medical_center_id
        AND b.date = s.date
        AND b.time >= s.start_time
        AND b.time < s.end_time;
    `);

    const bookingStatuses = await client.query(`SELECT id, status FROM bookings`);
    for (const row of bookingStatuses.rows) {
      const normalizedStatus = normalizeBookingStatus(row.status);
      if (normalizedStatus !== row.status) {
        await client.query(`UPDATE bookings SET status = $1 WHERE id = $2`, [
          normalizedStatus,
          row.id,
        ]);
      }
    }

    await client.query(`
      ALTER TABLE bookings
      DROP CONSTRAINT IF EXISTS bookings_status_check;
    `);

    await client.query(`
      ALTER TABLE bookings
      ADD CONSTRAINT bookings_status_check
      CHECK (status IN (
        '${BOOKING_STATUS.BOOKED}',
        '${BOOKING_STATUS.CONFIRMED}',
        '${BOOKING_STATUS.IN_PROGRESS}',
        '${BOOKING_STATUS.COMPLETED}',
        '${BOOKING_STATUS.MISSED}',
        '${BOOKING_STATUS.CANCELLED}'
      ));
    `);

    await client.query(`
      UPDATE bookings
      SET started_at = COALESCE(started_at, scheduled_at, ((date::timestamp) + time))
      WHERE status = '${BOOKING_STATUS.COMPLETED}'
        AND started_at IS NULL;
    `);

    await client.query(`
      UPDATE bookings
      SET ended_at = NULL
      WHERE status = '${BOOKING_STATUS.MISSED}'
        AND ended_at IS NOT NULL;
    `);

    await client.query(`
      ALTER TABLE bookings
      DROP CONSTRAINT IF EXISTS bookings_completed_requires_started_check,
      DROP CONSTRAINT IF EXISTS bookings_missed_disallows_ended_check;
    `);

    await client.query(`
      ALTER TABLE bookings
      ADD CONSTRAINT bookings_completed_requires_started_check
      CHECK (
        status <> '${BOOKING_STATUS.COMPLETED}'
        OR started_at IS NOT NULL
      ),
      ADD CONSTRAINT bookings_missed_disallows_ended_check
      CHECK (
        status <> '${BOOKING_STATUS.MISSED}'
        OR ended_at IS NULL
      );
    `);

    // Queue metrics support (if queue_patients exists).
    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.queues') IS NULL
          AND to_regclass('public.doctors') IS NOT NULL THEN
          CREATE TABLE queues (
            id SERIAL PRIMARY KEY,
            doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
            status VARCHAR(20) NOT NULL DEFAULT 'LIVE',
            created_at TIMESTAMP DEFAULT NOW(),
            started_at TIMESTAMP DEFAULT NOW(),
            ended_at TIMESTAMP,
            shift_id INTEGER,
            schedule_id INTEGER,
            shift_date DATE DEFAULT CURRENT_DATE,
            medical_center_id UUID REFERENCES medical_centers(id) ON DELETE CASCADE
          );
        END IF;

        IF to_regclass('public.queue_patients') IS NULL
          AND to_regclass('public.queues') IS NOT NULL
          AND to_regclass('public.users') IS NOT NULL THEN
          CREATE TABLE queue_patients (
            id SERIAL PRIMARY KEY,
            queue_id INTEGER REFERENCES queues(id) ON DELETE CASCADE,
            doctor_id INTEGER REFERENCES doctors(id) ON DELETE CASCADE,
            patient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            token_number INTEGER NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'WAITING',
            complaint TEXT,
            created_at TIMESTAMP DEFAULT NOW()
          );
        END IF;
      END $$;
    `);

    await client.query(`
      ALTER TABLE IF EXISTS queue_patients
      ADD COLUMN IF NOT EXISTS started_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS consultation_id INTEGER,
      ADD COLUMN IF NOT EXISTS missed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS is_walkin BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'normal';
    `);

    await client.query(`
      ALTER TABLE IF EXISTS queue_patients
      DROP CONSTRAINT IF EXISTS queue_patients_priority_check,
      ADD CONSTRAINT queue_patients_priority_check
      CHECK (LOWER(priority) IN ('normal', 'urgent', 'emergency'));
    `);

    await client.query(`
      DO $$
      DECLARE
        constraint_name TEXT;
      BEGIN
        IF to_regclass('public.queue_patients') IS NOT NULL THEN
          UPDATE queue_patients qp
          SET patient_id = NULL
          WHERE patient_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM users u
              WHERE u.id = qp.patient_id
            );

          FOR constraint_name IN
            SELECT c.conname
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_attribute a
              ON a.attrelid = t.oid
             AND a.attnum = ANY(c.conkey)
            WHERE t.relname = 'queue_patients'
              AND a.attname = 'patient_id'
              AND c.contype = 'f'
          LOOP
            EXECUTE format('ALTER TABLE queue_patients DROP CONSTRAINT %I', constraint_name);
          END LOOP;

          ALTER TABLE queue_patients
          ADD CONSTRAINT queue_patients_patient_id_fkey
          FOREIGN KEY (patient_id)
          REFERENCES users(id)
          ON DELETE CASCADE;
        END IF;
      END $$;
    `);

    await client.query(`
      ALTER TABLE IF EXISTS users
      ADD COLUMN IF NOT EXISTS medical_history JSONB,
      ADD COLUMN IF NOT EXISTS allergies TEXT;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS consultations (
        id SERIAL PRIMARY KEY,
        patient_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        doctor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        queue_id INTEGER,
        symptoms TEXT,
        diagnosis TEXT,
        notes TEXT,
        medicines JSONB DEFAULT '[]',
        status VARCHAR(20) DEFAULT 'draft',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE IF EXISTS consultations
      ADD COLUMN IF NOT EXISTS patient_id INTEGER,
      ADD COLUMN IF NOT EXISTS doctor_id INTEGER,
      ADD COLUMN IF NOT EXISTS queue_id INTEGER,
      ADD COLUMN IF NOT EXISTS medical_center_id UUID REFERENCES medical_centers(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS symptoms TEXT,
      ADD COLUMN IF NOT EXISTS diagnosis TEXT,
      ADD COLUMN IF NOT EXISTS notes TEXT,
      ADD COLUMN IF NOT EXISTS medicines JSONB DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'draft',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    `);

	    await client.query(`
	      CREATE TABLE IF NOT EXISTS prescriptions (
	        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	        consultation_id INTEGER REFERENCES consultations(id) ON DELETE CASCADE,
	        medical_center_id UUID REFERENCES medical_centers(id) ON DELETE CASCADE,
	        qr_code TEXT,
	        status VARCHAR(20) DEFAULT 'pending',
	        is_seen BOOLEAN DEFAULT false,
	        issued_at TIMESTAMP DEFAULT NOW(),
	        dispensed_at TIMESTAMP,
	        dispensed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
	        expires_at TIMESTAMP,
	        notes TEXT
	      )
	    `);

    await client.query(`
      DO $$
      BEGIN
	        IF to_regclass('public.prescriptions') IS NOT NULL THEN
	          ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS medical_center_id UUID REFERENCES medical_centers(id) ON DELETE CASCADE;
	          ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
	          ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS is_seen BOOLEAN DEFAULT false;
	          ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS issued_at TIMESTAMP DEFAULT NOW();
	          ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS dispensed_at TIMESTAMP;
	          ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS dispensed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
	          ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
	          ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS notes TEXT;
	        END IF;
	      END $$;
	    `);

	    await client.query(`
	      CREATE TABLE IF NOT EXISTS prescription_items (
	        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	        prescription_id UUID REFERENCES prescriptions(id) ON DELETE CASCADE,
	        medicine_id INTEGER REFERENCES medicines(id) ON DELETE SET NULL,
	        medicine_name TEXT,
	        quantity INTEGER DEFAULT 1,
	        dosage TEXT,
	        frequency TEXT,
	        duration TEXT,
	        instructions TEXT,
	        dispensed_quantity INTEGER DEFAULT 0,
	        matched_inventory_item_id INTEGER,
	        item_status TEXT NOT NULL DEFAULT 'pending',
	        fulfilled_quantity INTEGER NOT NULL DEFAULT 0,
	        substitution_allowed BOOLEAN NOT NULL DEFAULT TRUE
	      )
	    `);

    await client.query(`
      DO $$
      BEGIN
	        IF to_regclass('public.prescription_items') IS NOT NULL THEN
	          ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS medicine_id INTEGER REFERENCES medicines(id) ON DELETE SET NULL;
	          ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1;
	          ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS dispensed_quantity INTEGER DEFAULT 0;
	          ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS matched_inventory_item_id INTEGER;
	          ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS item_status TEXT NOT NULL DEFAULT 'pending';
	          ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS fulfilled_quantity INTEGER NOT NULL DEFAULT 0;
	          ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS substitution_allowed BOOLEAN NOT NULL DEFAULT TRUE;
	          UPDATE prescription_items SET dispensed_quantity = 0 WHERE dispensed_quantity IS NULL;
	          UPDATE prescription_items
	          SET fulfilled_quantity = COALESCE(fulfilled_quantity, dispensed_quantity, 0)
	          WHERE fulfilled_quantity IS NULL;
	        END IF;
	      END $$;
	    `);

    await client.query(`
      UPDATE prescription_items pi
      SET medicine_id = m.id
      FROM medicines m
      WHERE pi.medicine_id IS NULL
        AND pi.medicine_name IS NOT NULL
        AND LOWER(TRIM(pi.medicine_name)) = LOWER(m.name)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS brands (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS categories_name_unique_lower
      ON categories (LOWER(name))
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS brands_name_unique_lower
      ON brands (LOWER(name))
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS medicines (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
        description TEXT,
        image_url TEXT,
        quantity INTEGER,
        expiry_date DATE,
        price DECIMAL(10,2),
        avg_price NUMERIC(10,2),
        conflicts TEXT[] DEFAULT '{}'::TEXT[],
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.medicines') IS NOT NULL THEN
          ALTER TABLE medicines ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
          ALTER TABLE medicines ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL;
          ALTER TABLE medicines ADD COLUMN IF NOT EXISTS description TEXT;
          ALTER TABLE medicines ADD COLUMN IF NOT EXISTS image_url TEXT;
          ALTER TABLE medicines ADD COLUMN IF NOT EXISTS generic_name TEXT;
          ALTER TABLE medicines ADD COLUMN IF NOT EXISTS active_ingredient TEXT;
          ALTER TABLE medicines ADD COLUMN IF NOT EXISTS strength TEXT;
          ALTER TABLE medicines ADD COLUMN IF NOT EXISTS dosage_form TEXT;
          ALTER TABLE medicines ADD COLUMN IF NOT EXISTS quantity INT;
          ALTER TABLE medicines ADD COLUMN IF NOT EXISTS expiry_date DATE;
          ALTER TABLE medicines ADD COLUMN IF NOT EXISTS price DECIMAL(10,2);
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.medicines') IS NOT NULL THEN
          ALTER TABLE medicines DROP COLUMN IF EXISTS category;
          ALTER TABLE medicines DROP COLUMN IF EXISTS brand;
          ALTER TABLE medicines DROP COLUMN IF EXISTS stock;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory (
        id BIGSERIAL PRIMARY KEY,
        pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
        medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
        stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
        unit_price NUMERIC(10,2),
        reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (pharmacy_id, medicine_id)
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.inventory') IS NOT NULL THEN
          ALTER TABLE inventory ADD COLUMN IF NOT EXISTS pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE;
          ALTER TABLE inventory ADD COLUMN IF NOT EXISTS medicine_id INTEGER REFERENCES medicines(id) ON DELETE CASCADE;
          ALTER TABLE inventory ADD COLUMN IF NOT EXISTS stock INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE inventory ADD COLUMN IF NOT EXISTS unit_price NUMERIC(10,2);
          ALTER TABLE inventory ADD COLUMN IF NOT EXISTS reserved_quantity INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE inventory ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
          ALTER TABLE inventory ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      UPDATE inventory
      SET reserved_quantity = 0
      WHERE reserved_quantity IS NULL
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_pharmacy_medicine_unique
      ON inventory (pharmacy_id, medicine_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_stock
      ON inventory (pharmacy_id, stock)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id BIGSERIAL PRIMARY KEY,
        pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE,
        prescription_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL,
        sold_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        total_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.sales') IS NOT NULL THEN
          ALTER TABLE sales ADD COLUMN IF NOT EXISTS pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE;
          ALTER TABLE sales ADD COLUMN IF NOT EXISTS prescription_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL;
          ALTER TABLE sales ADD COLUMN IF NOT EXISTS sold_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
          ALTER TABLE sales ADD COLUMN IF NOT EXISTS total_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
          ALTER TABLE sales ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
          ALTER TABLE sales ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sales_pharmacy_created
      ON sales (pharmacy_id, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sales_prescription_id
      ON sales (prescription_id)
      WHERE prescription_id IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sale_items (
        id BIGSERIAL PRIMARY KEY,
        sale_id BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE RESTRICT,
        prescription_item_id TEXT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_price NUMERIC(10,2) NOT NULL,
        line_total NUMERIC(10,2),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.sale_items') IS NOT NULL THEN
          ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS sale_id BIGINT REFERENCES sales(id) ON DELETE CASCADE;
          ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS medicine_id INTEGER REFERENCES medicines(id) ON DELETE RESTRICT;
          ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS prescription_item_id TEXT;
          ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS quantity INTEGER;
          ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS unit_price NUMERIC(10,2);
          ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS line_total NUMERIC(10,2);
          ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
          ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'sale_items'
            AND column_name = 'prescription_item_id'
            AND data_type <> 'text'
        ) THEN
          ALTER TABLE sale_items
          ALTER COLUMN prescription_item_id TYPE TEXT
          USING prescription_item_id::text;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id
      ON sale_items (sale_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sale_items_medicine_id
      ON sale_items (medicine_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sale_items_prescription_item
      ON sale_items (prescription_item_id)
      WHERE prescription_item_id IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS demand_logs (
        id BIGSERIAL PRIMARY KEY,
        pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE,
        medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
        prescription_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL,
        source TEXT NOT NULL DEFAULT 'dispense',
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.demand_logs') IS NOT NULL THEN
          ALTER TABLE demand_logs ADD COLUMN IF NOT EXISTS pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE;
          ALTER TABLE demand_logs ADD COLUMN IF NOT EXISTS medicine_id INTEGER REFERENCES medicines(id) ON DELETE CASCADE;
          ALTER TABLE demand_logs ADD COLUMN IF NOT EXISTS prescription_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL;
          ALTER TABLE demand_logs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'dispense';
          ALTER TABLE demand_logs ADD COLUMN IF NOT EXISTS quantity INTEGER;
          ALTER TABLE demand_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_demand_logs_pharmacy_medicine_created
      ON demand_logs (pharmacy_id, medicine_id, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_demand_logs_prescription_id
      ON demand_logs (prescription_id)
      WHERE prescription_id IS NOT NULL
    `);

    await client.query(`
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
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.marketplace_products') IS NOT NULL THEN
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE;
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS inventory_item_id INTEGER REFERENCES medicines(id) ON DELETE CASCADE;
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS name TEXT;
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS generic_name TEXT;
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS brand TEXT;
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS description TEXT;
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS category TEXT;
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS price NUMERIC(10,2);
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS discount_price NUMERIC(10,2);
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS image_url TEXT;
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS requires_prescription BOOLEAN NOT NULL DEFAULT FALSE;
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
          ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_products_pharmacy_inventory_unique
      ON marketplace_products (pharmacy_id, inventory_item_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_marketplace_products_pharmacy_active
      ON marketplace_products (pharmacy_id, is_active, is_featured, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_marketplace_products_search
      ON marketplace_products (
        LOWER(COALESCE(name, '')),
        LOWER(COALESCE(generic_name, '')),
        LOWER(COALESCE(brand, ''))
      )
    `);

    await client.query(`
      ALTER TABLE IF EXISTS inventory
      ADD COLUMN IF NOT EXISTS reserved_quantity INTEGER NOT NULL DEFAULT 0
    `);

    await client.query(`
      UPDATE inventory
      SET reserved_quantity = 0
      WHERE reserved_quantity IS NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS carts (
        id BIGSERIAL PRIMARY KEY,
        patient_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.carts') IS NOT NULL THEN
          ALTER TABLE carts ADD COLUMN IF NOT EXISTS patient_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
          ALTER TABLE carts ADD COLUMN IF NOT EXISTS pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE SET NULL;
          ALTER TABLE carts ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
          ALTER TABLE carts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cart_items (
        id BIGSERIAL PRIMARY KEY,
        cart_id BIGINT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
        marketplace_product_id BIGINT NOT NULL REFERENCES marketplace_products(id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (cart_id, marketplace_product_id)
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.cart_items') IS NOT NULL THEN
          ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS cart_id BIGINT REFERENCES carts(id) ON DELETE CASCADE;
          ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS marketplace_product_id BIGINT REFERENCES marketplace_products(id) ON DELETE CASCADE;
          ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS quantity INTEGER;
          ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
          ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGSERIAL PRIMARY KEY,
        patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        subtotal NUMERIC(10,2) NOT NULL,
        discount_total NUMERIC(10,2) NOT NULL DEFAULT 0,
        total NUMERIC(10,2) NOT NULL,
        currency TEXT NOT NULL DEFAULT 'LKR',
        fulfillment_type TEXT NOT NULL DEFAULT 'pickup',
        payment_method TEXT,
        payment_status TEXT,
        paid_at TIMESTAMP,
        invoice_id BIGINT,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

	    await client.query(`
	      DO $$
	      BEGIN
	        IF to_regclass('public.orders') IS NOT NULL THEN
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS patient_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS prescription_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_code TEXT;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10,2);
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_total NUMERIC(10,2) NOT NULL DEFAULT 0;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS total NUMERIC(10,2);
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'LKR';
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_type TEXT NOT NULL DEFAULT 'pickup';
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_id BIGINT;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS pharmacist_note TEXT;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address JSONB;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_notes TEXT;
	          ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_contact_name TEXT;
          ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_contact_phone TEXT;
          ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_started_at TIMESTAMP;
          ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
          ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
          ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id BIGSERIAL PRIMARY KEY,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        marketplace_product_id BIGINT NOT NULL REFERENCES marketplace_products(id) ON DELETE RESTRICT,
        inventory_item_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_price NUMERIC(10,2) NOT NULL,
        total_price NUMERIC(10,2) NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

	    await client.query(`
	      DO $$
	      BEGIN
	        IF to_regclass('public.order_items') IS NOT NULL THEN
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE;
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS marketplace_product_id BIGINT REFERENCES marketplace_products(id) ON DELETE RESTRICT;
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS inventory_item_id INTEGER REFERENCES medicines(id) ON DELETE RESTRICT;
		          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS prescription_item_id TEXT;
		          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS substituted_inventory_item_id INTEGER REFERENCES medicines(id) ON DELETE SET NULL;
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS substitution_approved BOOLEAN NOT NULL DEFAULT FALSE;
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS quantity INTEGER;
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS requested_quantity INTEGER;
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS approved_quantity INTEGER;
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_price NUMERIC(10,2);
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS total_price NUMERIC(10,2);
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS substitution_name TEXT;
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS note TEXT;
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
	          ALTER TABLE order_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
	        END IF;
		      END $$;
		    `);

	    await client.query(`
	      DO $$
	      BEGIN
	        IF EXISTS (
	          SELECT 1
	          FROM information_schema.columns
	          WHERE table_schema = 'public'
	            AND table_name = 'order_items'
	            AND column_name = 'prescription_item_id'
	            AND data_type <> 'text'
	        ) THEN
	          ALTER TABLE order_items
	          ALTER COLUMN prescription_item_id TYPE TEXT
	          USING prescription_item_id::text;
	        END IF;
	      END $$;
	    `);

	    await client.query(`
	      UPDATE orders
	      SET order_code = CONCAT('HL-', id)
	      WHERE order_code IS NULL
	    `);

	    await client.query(`
	      UPDATE orders
	      SET payment_method = COALESCE(payment_method, 'cash')
	      WHERE payment_method IS NULL
	    `);

	    await client.query(`
	      UPDATE order_items
	      SET requested_quantity = COALESCE(requested_quantity, quantity),
	          approved_quantity = COALESCE(approved_quantity, quantity)
	      WHERE requested_quantity IS NULL
	         OR approved_quantity IS NULL
	    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id BIGSERIAL PRIMARY KEY,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
        gateway TEXT NOT NULL,
        gateway_payment_id TEXT,
        gateway_order_id TEXT,
        amount NUMERIC(10,2) NOT NULL,
        currency TEXT NOT NULL DEFAULT 'LKR',
        status TEXT NOT NULL DEFAULT 'pending',
        method TEXT,
        card_no_masked TEXT,
        status_message TEXT,
        raw_payload JSONB,
        verified_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.payments') IS NOT NULL THEN
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE;
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS patient_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE;
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway TEXT;
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_payment_id TEXT;
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_order_id TEXT;
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount NUMERIC(10,2);
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'LKR';
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS method TEXT;
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS card_no_masked TEXT;
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS status_message TEXT;
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS raw_payload JSONB;
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
          ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      ALTER TABLE payments
      DROP CONSTRAINT IF EXISTS payments_status_check;
    `);

    await client.query(`
      ALTER TABLE payments
      ADD CONSTRAINT payments_status_check
      CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'refunded'));
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id BIGSERIAL PRIMARY KEY,
        invoice_no TEXT NOT NULL UNIQUE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        payment_id BIGINT REFERENCES payments(id) ON DELETE SET NULL,
        patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
        subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
        delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
        service_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
        discount NUMERIC(10,2) NOT NULL DEFAULT 0,
        total NUMERIC(10,2) NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'LKR',
        pdf_url TEXT,
        issued_at TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.invoices') IS NOT NULL THEN
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_no TEXT;
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE;
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_id BIGINT REFERENCES payments(id) ON DELETE SET NULL;
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS patient_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE;
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10,2) NOT NULL DEFAULT 0;
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS service_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount NUMERIC(10,2) NOT NULL DEFAULT 0;
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS total NUMERIC(10,2) NOT NULL DEFAULT 0;
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'LKR';
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_url TEXT;
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issued_at TIMESTAMP NOT NULL DEFAULT NOW();
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
          ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
        END IF;
      END $$;
    `);

    await client.query(`
      UPDATE invoices
      SET invoice_no = CONCAT('HL-INV-', TO_CHAR(COALESCE(issued_at, created_at, NOW()), 'YYYYMMDD'), '-', LPAD(id::text, 6, '0'))
      WHERE invoice_no IS NULL
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.orders') IS NOT NULL
          AND to_regclass('public.invoices') IS NOT NULL THEN
          BEGIN
            ALTER TABLE orders
            ADD CONSTRAINT orders_invoice_id_fkey
            FOREIGN KEY (invoice_id)
            REFERENCES invoices(id)
            ON DELETE SET NULL;
          EXCEPTION
            WHEN duplicate_object THEN NULL;
          END;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id
      ON cart_items (cart_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_patient_created
      ON orders (patient_id, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_pharmacy_status_created
      ON orders (pharmacy_id, status, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_payment_status
      ON orders (payment_method, payment_status, status)
    `);

	    await client.query(`
	      CREATE INDEX IF NOT EXISTS idx_order_items_order_id
	      ON order_items (order_id)
	    `);

	    await client.query(`
	      CREATE INDEX IF NOT EXISTS idx_orders_prescription_id
	      ON orders (prescription_id)
	      WHERE prescription_id IS NOT NULL
	    `);

	    await client.query(`
	      CREATE INDEX IF NOT EXISTS idx_orders_prescription_active
	      ON orders (prescription_id, status)
	      WHERE prescription_id IS NOT NULL
	    `);

	    await client.query(`
	      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_code
	      ON orders (order_code)
	      WHERE order_code IS NOT NULL
	    `);

	    await client.query(`
	      CREATE INDEX IF NOT EXISTS idx_order_items_prescription_item
	      ON order_items (prescription_item_id)
	      WHERE prescription_item_id IS NOT NULL
	    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_order_id
      ON payments (order_id, created_at DESC)
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_gateway_order_id
      ON payments (gateway_order_id)
      WHERE gateway_order_id IS NOT NULL
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_gateway_payment_id
      ON payments (gateway_payment_id)
      WHERE gateway_payment_id IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_patient_status
      ON payments (patient_id, status, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_pharmacy_status
      ON payments (pharmacy_id, status, created_at DESC)
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_order_id
      ON invoices (order_id)
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_payment_id
      ON invoices (payment_id)
      WHERE payment_id IS NOT NULL
    `);

	    await client.query(`
	      CREATE TABLE IF NOT EXISTS push_tokens (
	        id BIGSERIAL PRIMARY KEY,
	        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	        role TEXT,
	        expo_push_token TEXT NOT NULL,
	        device_platform TEXT,
	        device_name TEXT,
	        device_model TEXT,
	        app_version TEXT,
	        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
	        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
	        UNIQUE (user_id, expo_push_token)
	      )
	    `);

	    await client.query(`
	      DO $$
	      BEGIN
	        IF to_regclass('public.push_tokens') IS NOT NULL THEN
	          ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
	          ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS role TEXT;
	          ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS expo_push_token TEXT;
	          ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS device_platform TEXT;
	          ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS device_name TEXT;
	          ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS device_model TEXT;
	          ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS app_version TEXT;
	          ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
	          ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
	        END IF;
	      END $$;
	    `);

	    await client.query(`
	      CREATE TABLE IF NOT EXISTS notifications (
	        id BIGSERIAL PRIMARY KEY,
	        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	        title TEXT NOT NULL,
	        body TEXT NOT NULL,
	        type TEXT NOT NULL,
	        is_read BOOLEAN NOT NULL DEFAULT FALSE,
	        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
	        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
	      )
	    `);

	    await client.query(`
	      DO $$
	      BEGIN
	        IF to_regclass('public.notifications') IS NOT NULL THEN
	          ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
	          ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title TEXT;
	          ALTER TABLE notifications ADD COLUMN IF NOT EXISTS body TEXT;
	          ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type TEXT;
	          ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;
	          ALTER TABLE notifications ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
	          ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
	          ALTER TABLE notifications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
	        END IF;
	      END $$;
	    `);

	    await client.query(`
	      CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id
	      ON push_tokens (user_id, updated_at DESC)
	    `);

	    await client.query(`
	      CREATE INDEX IF NOT EXISTS idx_notifications_user_created
	      ON notifications (user_id, created_at DESC)
	    `);

	    await client.query(`
	      CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
	      ON notifications (user_id, is_read, created_at DESC)
	    `);

	    await client.query(`
	      CREATE TABLE IF NOT EXISTS activity_logs (
	        id BIGSERIAL PRIMARY KEY,
	        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
	        order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,
	        prescription_id UUID REFERENCES prescriptions(id) ON DELETE CASCADE,
	        queue_id INTEGER REFERENCES queues(id) ON DELETE CASCADE,
	        type TEXT NOT NULL,
	        title TEXT NOT NULL,
	        description TEXT,
	        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	        created_at TIMESTAMP NOT NULL DEFAULT NOW()
	      )
	    `);

	    await client.query(`
	      DO $$
	      BEGIN
	        IF to_regclass('public.activity_logs') IS NOT NULL THEN
	          ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
	          ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE;
	          ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS prescription_id UUID REFERENCES prescriptions(id) ON DELETE CASCADE;
	          ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS queue_id INTEGER REFERENCES queues(id) ON DELETE CASCADE;
	          ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS type TEXT;
	          ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS title TEXT;
	          ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS description TEXT;
	          ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
	          ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
	        END IF;
	      END $$;
	    `);

	    await client.query(`
	      CREATE INDEX IF NOT EXISTS idx_activity_logs_user_created
	      ON activity_logs (user_id, created_at DESC)
	    `);

	    await client.query(`
	      CREATE INDEX IF NOT EXISTS idx_activity_logs_order_created
	      ON activity_logs (order_id, created_at ASC)
	      WHERE order_id IS NOT NULL
	    `);

	    await client.query(`
	      CREATE INDEX IF NOT EXISTS idx_activity_logs_prescription_created
	      ON activity_logs (prescription_id, created_at DESC)
	      WHERE prescription_id IS NOT NULL
	    `);

    // Shift-aware queues (per doctor shift per day).
    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.queues') IS NOT NULL THEN
          IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'queues'
              AND column_name IN (
                'medical_center_id',
                'shift_id',
                'schedule_id',
                'shift_date',
                'created_at',
                'started_at',
                'ended_at'
              )
            GROUP BY table_name
            HAVING COUNT(*) < 7
          ) THEN
            ALTER TABLE queues
              ADD COLUMN IF NOT EXISTS medical_center_id UUID REFERENCES medical_centers(id) ON DELETE CASCADE,
              ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES doctor_availability(id) ON DELETE SET NULL,
              ADD COLUMN IF NOT EXISTS schedule_id INTEGER REFERENCES medical_center_doctor_schedule(id) ON DELETE SET NULL,
              ADD COLUMN IF NOT EXISTS shift_date DATE DEFAULT CURRENT_DATE,
              ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(),
              ADD COLUMN IF NOT EXISTS started_at TIMESTAMP,
              ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP;
          END IF;

          IF to_regclass('public.unique_doctor_daily_queue') IS NOT NULL THEN
            DROP INDEX unique_doctor_daily_queue;
          END IF;

          CREATE UNIQUE INDEX IF NOT EXISTS unique_doctor_shift_queue
          ON queues (doctor_id, shift_id, shift_date);

          CREATE UNIQUE INDEX IF NOT EXISTS unique_doctor_schedule_queue
          ON queues (doctor_id, schedule_id, shift_date)
          WHERE schedule_id IS NOT NULL;
        END IF;
      END $$;
    `);

    await client.query(`
      ALTER TABLE IF EXISTS queue_patients
      ADD COLUMN IF NOT EXISTS medical_center_id UUID REFERENCES medical_centers(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES medical_center_doctor_schedule(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS is_walkin BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'normal';
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_queue_patients_queue_token
      ON queue_patients (queue_id, token_number);
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS queue_patients_unique_queue_patient_active
      ON queue_patients (queue_id, patient_id)
      WHERE patient_id IS NOT NULL AND status IN ('WAITING', 'WITH_DOCTOR');
    `);

    await client.query(`
      UPDATE queue_patients qp
      SET session_id = q.schedule_id
      FROM queues q
      WHERE qp.queue_id = q.id
        AND qp.session_id IS NULL
        AND q.schedule_id IS NOT NULL;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS queue_patients_unique_patient_session
      ON queue_patients (patient_id, session_id)
      WHERE session_id IS NOT NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_doctors_medical_center_id ON doctors (medical_center_id);
      CREATE INDEX IF NOT EXISTS idx_receptionists_medical_center_id ON receptionists (medical_center_id);
      CREATE INDEX IF NOT EXISTS idx_bookings_medical_center_id ON bookings (medical_center_id);
      CREATE INDEX IF NOT EXISTS idx_consultations_medical_center_id ON consultations (medical_center_id);
      CREATE INDEX IF NOT EXISTS idx_prescriptions_medical_center_id ON prescriptions (medical_center_id);
      CREATE INDEX IF NOT EXISTS idx_medical_center_admins_center_id ON medical_center_admins (medical_center_id);
    `);

    await client.query(`
      UPDATE bookings b
      SET medical_center_id = d.medical_center_id
      FROM doctors d
      WHERE b.doctor_id = d.id
        AND b.medical_center_id IS NULL
        AND d.medical_center_id IS NOT NULL;
    `);

    await client.query(`
      UPDATE consultations c
      SET medical_center_id = d.medical_center_id
      FROM doctors d
      WHERE c.doctor_id = d.user_id
        AND c.medical_center_id IS NULL
        AND d.medical_center_id IS NOT NULL;
    `);

    await client.query(`
      UPDATE prescriptions p
      SET medical_center_id = c.medical_center_id
      FROM consultations c
      WHERE p.consultation_id = c.id
        AND p.medical_center_id IS NULL
        AND c.medical_center_id IS NOT NULL;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.queues') IS NOT NULL AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'queues' AND column_name = 'doctor_id'
        ) THEN
          UPDATE queues q
          SET medical_center_id = d.medical_center_id
          FROM doctors d
          WHERE q.doctor_id = d.id
            AND q.medical_center_id IS NULL
            AND d.medical_center_id IS NOT NULL;
        END IF;
      END $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF to_regclass('public.queue_patients') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'queue_patients' AND column_name = 'doctor_id'
          ) THEN
          UPDATE queue_patients qp
          SET medical_center_id = d.medical_center_id
          FROM doctors d
          WHERE qp.doctor_id = d.id
            AND qp.medical_center_id IS NULL
            AND d.medical_center_id IS NOT NULL;
        END IF;
      END $$;
    `);

    console.log("✅ PostgreSQL connected and schema ready");
  } catch (err) {
    if (!isRetryableInitDbError(err)) {
      console.error("❌ DB initialization failed:", err);
    }
    throw err;
  } finally {
    if (sessionTimeoutsConfigured) {
      try {
        await client.query("RESET statement_timeout");
        await client.query("RESET lock_timeout");
      } catch (resetError) {
        console.error("⚠️ Failed to reset DB init session settings:", resetError);
      }
    }
    if (advisoryLockHeld) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [INIT_DB_ADVISORY_LOCK_KEY]);
      } catch (unlockError) {
        console.error("⚠️ Failed to release DB init advisory lock:", unlockError);
      }
    }
    client.release();
  }
};

export const initDb = async () => {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= INIT_DB_MAX_ATTEMPTS; attempt += 1) {
    try {
      await initDbOnce();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableInitDbError(error) || attempt === INIT_DB_MAX_ATTEMPTS) {
        throw error;
      }

      console.warn(
        `⚠️ DB initialization attempt ${attempt} failed with a transient lock error. Retrying in ${INIT_DB_RETRY_DELAY_MS}ms...`
      );
      await sleep(INIT_DB_RETRY_DELAY_MS);
    }
  }

  throw lastError;
};

export default pool;
