import type { Request } from "express";
import pool from "../config/db";
import { getCloudinary } from "../config/cloudinary";
import { env } from "../config/env";
import type { UploadedFile } from "../types/uploads";

export type DashboardBannerTargetType =
  | "none"
  | "medical_center"
  | "pharmacy"
  | "doctor"
  | "prescription_upload"
  | "appointments"
  | string;

export type DashboardBannerInput = {
  title: string | null;
  subtitle: string | null;
  targetType: DashboardBannerTargetType | null;
  targetId: string | null;
  targetScreen: string | null;
  isActive: boolean;
  sortOrder: number;
  startDate: string | null;
  endDate: string | null;
};

export type DashboardBanner = {
  id: string;
  title: string | null;
  subtitle: string | null;
  imageUrl: string;
  targetType: string | null;
  targetId: string | null;
  targetScreen: string | null;
  isActive: boolean;
  sortOrder: number;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
};

type DashboardBannerRow = {
  id: string;
  title: string | null;
  subtitle: string | null;
  image_url: string;
  target_type: string | null;
  target_id: string | null;
  target_screen: string | null;
  is_active: boolean;
  sort_order: number;
  start_date: Date | string | null;
  end_date: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const hasCloudinaryConfig = () =>
  Boolean(env.cloudinaryName && env.cloudinaryKey && env.cloudinarySecret);

const toIsoString = (value: Date | string | null) => {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
};

const mapBanner = (row: DashboardBannerRow): DashboardBanner => ({
  id: row.id,
  title: row.title,
  subtitle: row.subtitle,
  imageUrl: row.image_url,
  targetType: row.target_type,
  targetId: row.target_id,
  targetScreen: row.target_screen,
  isActive: row.is_active,
  sortOrder: row.sort_order,
  startDate: toIsoString(row.start_date),
  endDate: toIsoString(row.end_date),
  createdAt: toIsoString(row.created_at) ?? "",
  updatedAt: toIsoString(row.updated_at) ?? "",
});

const getPublicBaseUrl = (req: Request) => {
  const configured = String(env.publicAppUrl || "").trim();
  if (configured) return configured.replace(/\/+$/, "");

  const host = req.get("host");
  return host ? `${req.protocol}://${host}` : "";
};

const uploadBannerImage = async (file: UploadedFile) => {
  if (!hasCloudinaryConfig()) {
    throw new Error("Cloudinary is not configured");
  }

  const cloudinary = getCloudinary();

  return new Promise<{ secureUrl: string; publicId: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "healthlink/dashboard-banners",
        resource_type: "image",
        transformation: [
          {
            width: 1600,
            height: 700,
            crop: "fill",
            quality: "auto",
            fetch_format: "auto",
          },
        ],
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error("Banner upload failed"));
          return;
        }

        resolve({
          secureUrl: result.secure_url,
          publicId: result.public_id,
        });
      }
    );

    stream.end(file.buffer);
  });
};

export const uploadDashboardBannerImage = async (_req: Request, file: UploadedFile) =>
  uploadBannerImage(file);

export const listAdminDashboardBanners = async () => {
  const result = await pool.query<DashboardBannerRow>(
    `
    SELECT id, title, subtitle, image_url, target_type, target_id, target_screen,
           is_active, sort_order, start_date, end_date, created_at, updated_at
    FROM dashboard_banners
    ORDER BY sort_order ASC, created_at DESC
    `
  );

  return result.rows.map(mapBanner);
};

export const listPatientDashboardBanners = async () => {
  const result = await pool.query<DashboardBannerRow>(
    `
    SELECT id, title, subtitle, image_url, target_type, target_id, target_screen,
           is_active, sort_order, start_date, end_date, created_at, updated_at
    FROM dashboard_banners
    WHERE is_active = TRUE
      AND (start_date IS NULL OR start_date <= NOW())
      AND (end_date IS NULL OR end_date >= NOW())
    ORDER BY sort_order ASC, created_at DESC
    `
  );

  return result.rows.map(mapBanner);
};

export const createDashboardBanner = async (input: DashboardBannerInput, imageUrl: string, createdBy: number | null) => {
  const result = await pool.query<DashboardBannerRow>(
    `
    INSERT INTO dashboard_banners (
      title, subtitle, image_url, target_type, target_id, target_screen,
      is_active, sort_order, start_date, end_date, created_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, NULL)
    RETURNING id, title, subtitle, image_url, target_type, target_id, target_screen,
              is_active, sort_order, start_date, end_date, created_at, updated_at
    `,
    [
      input.title,
      input.subtitle,
      imageUrl,
      input.targetType,
      input.targetId,
      input.targetScreen,
      input.isActive,
      input.sortOrder,
      input.startDate,
      input.endDate,
    ]
  );

  void createdBy;
  return mapBanner(result.rows[0]);
};

export const updateDashboardBanner = async (id: string, input: DashboardBannerInput, imageUrl?: string) => {
  const result = await pool.query<DashboardBannerRow>(
    `
    UPDATE dashboard_banners
    SET title = $2,
        subtitle = $3,
        image_url = COALESCE($4, image_url),
        target_type = $5,
        target_id = $6,
        target_screen = $7,
        is_active = $8,
        sort_order = $9,
        start_date = $10::timestamptz,
        end_date = $11::timestamptz,
        updated_at = NOW()
    WHERE id = $1::uuid
    RETURNING id, title, subtitle, image_url, target_type, target_id, target_screen,
              is_active, sort_order, start_date, end_date, created_at, updated_at
    `,
    [
      id,
      input.title,
      input.subtitle,
      imageUrl ?? null,
      input.targetType,
      input.targetId,
      input.targetScreen,
      input.isActive,
      input.sortOrder,
      input.startDate,
      input.endDate,
    ]
  );

  return result.rows[0] ? mapBanner(result.rows[0]) : null;
};

export const deleteDashboardBanner = async (id: string) => {
  const result = await pool.query<{ id: string }>(
    `
    DELETE FROM dashboard_banners
    WHERE id = $1::uuid
    RETURNING id
    `,
    [id]
  );

  return result.rows[0] ?? null;
};

export const resolveDashboardBannerImageUrl = (req: Request, value: string) => {
  if (/^https?:\/\//i.test(value)) return value;
  const baseUrl = getPublicBaseUrl(req);
  return baseUrl ? `${baseUrl}${value.startsWith("/") ? value : `/${value}`}` : value;
};
