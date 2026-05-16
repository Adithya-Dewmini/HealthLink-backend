import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { Request, Response } from "express";
import pool from "../config/db";
import { getCloudinary } from "../config/cloudinary";
import { env } from "../config/env";
import { analyzePrescriptionImage } from "../services/upload.service";
import type { UploadedFile } from "../types/uploads";
import type { AuthenticatedRequest } from "../types/auth";

const LOCAL_IMAGE_UPLOAD_DIR = path.resolve(process.cwd(), "uploads", "images");

const hasCloudinaryConfig = () =>
  Boolean(env.cloudinaryName && env.cloudinaryKey && env.cloudinarySecret);

const getFileExtension = (file: UploadedFile) => {
  const originalExtension = path.extname(file.originalname || "").trim();
  if (originalExtension) {
    return originalExtension.toLowerCase();
  }

  if (file.mimetype === "image/png") return ".png";
  if (file.mimetype === "image/webp") return ".webp";

  return ".jpg";
};

const getPublicBaseUrl = (req: Request) => {
  const configured = String(env.publicAppUrl || "").trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const host = req.get("host");
  if (host) {
    return `${req.protocol}://${host}`;
  }

  return "";
};

const toPublicFileUrl = (req: Request, relativePath: string) => {
  const baseUrl = getPublicBaseUrl(req);
  return `${baseUrl}${relativePath.startsWith("/") ? relativePath : `/${relativePath}`}`;
};

const uploadImageToCloudinary = async (file: UploadedFile, folder: string) => {
  const cloudinary = getCloudinary();

  return new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error("Upload failed"));
          return;
        }
        resolve({
          secure_url: result.secure_url,
          public_id: result.public_id,
        });
      }
    );

    stream.end(file.buffer);
  });
};

const uploadImageToLocalStorage = async (req: Request, file: UploadedFile) => {
  await fs.mkdir(LOCAL_IMAGE_UPLOAD_DIR, { recursive: true });
  const fileName = `${Date.now()}-${randomUUID()}${getFileExtension(file)}`;
  const destination = path.join(LOCAL_IMAGE_UPLOAD_DIR, fileName);
  await fs.writeFile(destination, file.buffer);

  const relativePath = `/uploads/images/${fileName}`;
  return {
    secure_url: toPublicFileUrl(req, relativePath),
    public_id: relativePath,
  };
};

const uploadImageBuffer = async (req: Request, file: UploadedFile, folder: string) => {
  if (hasCloudinaryConfig()) {
    return uploadImageToCloudinary(file, folder);
  }

  return uploadImageToLocalStorage(req, file);
};

export const uploadPrescription = async (req: Request, res: Response) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "No image uploaded" });
    }

    console.log("UPLOADED FILE:", file.originalname);
    const data = await analyzePrescriptionImage(file);

    return res.json({
      message: "Analysis complete",
      fileName: file.originalname,
      data,
    });
  } catch (error) {
    console.error("UPLOAD ERROR:", error);
    return res.status(500).json({ message: "Analysis failed" });
  }
};

export const uploadProfileImage = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const file = req.file;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!file) {
      return res.status(400).json({ message: "No image uploaded" });
    }

    const uploaded = await uploadImageBuffer(req, file, "healthlink/profiles");
    await pool.query(
      `
      UPDATE users
      SET profile_image = $1,
          profile_image_id = $2
      WHERE id = $3
      `,
      [uploaded.secure_url, uploaded.public_id, userId]
    );

    return res.json({
      success: true,
      data: {
        imageUrl: uploaded.secure_url,
        imageId: uploaded.public_id,
      },
    });
  } catch (error) {
    console.error("PROFILE UPLOAD ERROR:", error);
    return res.status(500).json({ message: "Profile image upload is not available right now" });
  }
};

type UploadedMedia = {
  secure_url: string;
  public_id: string;
};

const asTrimmedString = (value: unknown) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
};

const requireRole = (req: AuthenticatedRequest, expectedRole: string) => {
  const role = String(req.user?.role || "").trim().toLowerCase();
  if (role !== expectedRole) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
};

const getUploadedFiles = (req: Request) => {
  const uploadedFiles = req.files && !Array.isArray(req.files) ? req.files : {};
  const logoFile = uploadedFiles.logo?.[0] ?? null;
  const coverFile = uploadedFiles.cover?.[0] ?? null;

  return { logoFile, coverFile };
};

const uploadEntityMedia = async (
  req: Request,
  logoFile: UploadedFile | null,
  coverFile: UploadedFile | null,
  folder: string
) => {
  const [logoUpload, coverUpload] = await Promise.all([
    logoFile ? uploadImageBuffer(req, logoFile, `${folder}/logos`) : Promise.resolve<UploadedMedia | null>(null),
    coverFile ? uploadImageBuffer(req, coverFile, `${folder}/covers`) : Promise.resolve<UploadedMedia | null>(null),
  ]);

  return { logoUpload, coverUpload };
};

export const uploadClinicImages = async (req: AuthenticatedRequest, res: Response) => {
  try {
    requireRole(req, "medical_center_admin");

    const clinicId = asTrimmedString(req.body?.clinicId) || req.user?.medicalCenterId || null;
    const userId = req.user?.id;
    const { logoFile, coverFile } = getUploadedFiles(req);

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!clinicId) {
      return res.status(400).json({ message: "clinicId is required" });
    }

    if (!logoFile && !coverFile) {
      return res.status(400).json({ message: "At least one image file is required" });
    }

    const existingResult = await pool.query<{
      id: string;
      image_url: string | null;
      logo_url: string | null;
      cover_image_url: string | null;
    }>(
      `
      SELECT mc.id, mc.image_url, mc.logo_url, mc.cover_image_url
      FROM medical_centers mc
      JOIN medical_center_admins mca
        ON mca.medical_center_id = mc.id
      WHERE mca.user_id = $1
        AND mc.id = $2::uuid
      LIMIT 1
      `,
      [userId, clinicId]
    );

    const existing = existingResult.rows[0];
    if (!existing) {
      return res.status(404).json({ message: "Medical center not found" });
    }

    const { logoUpload, coverUpload } = await uploadEntityMedia(req, logoFile, coverFile, "healthlink/medical-centers");
    const nextLogoUrl = logoUpload?.secure_url ?? existing.logo_url;
    const nextCoverUrl = coverUpload?.secure_url ?? existing.cover_image_url;
    const nextImageUrl = nextCoverUrl || existing.image_url || nextLogoUrl || null;

    await pool.query(
      `
      UPDATE medical_centers
      SET
        logo_url = $1,
        logo_id = $2,
        cover_image_url = $3,
        cover_id = $4,
        image_url = $5
      WHERE id = $6::uuid
      `,
      [
        nextLogoUrl,
        logoUpload?.public_id ?? null,
        nextCoverUrl,
        coverUpload?.public_id ?? null,
        nextImageUrl,
        clinicId,
      ]
    );

    return res.json({
      success: true,
      data: {
        logoUrl: nextLogoUrl,
        logoId: logoUpload?.public_id ?? null,
        coverUrl: nextCoverUrl,
        coverId: coverUpload?.public_id ?? null,
        imageUrl: nextImageUrl,
      },
    });
  } catch (error) {
    console.error("CLINIC IMAGE UPLOAD ERROR:", error);
    const statusCode = Number((error as { statusCode?: number })?.statusCode) || 500;
    return res.status(statusCode).json({
      message: statusCode === 403 ? "Only medical center admins can upload images" : "Clinic image upload failed",
    });
  }
};

export const uploadPharmacyImages = async (req: AuthenticatedRequest, res: Response) => {
  try {
    requireRole(req, "pharmacist");

    const pharmacyId = asTrimmedString(req.body?.pharmacyId);
    const userId = req.user?.id;
    const { logoFile, coverFile } = getUploadedFiles(req);

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!logoFile && !coverFile) {
      return res.status(400).json({ message: "At least one image file is required" });
    }

    const params: Array<number | string> = [userId];
    const pharmacyFilter = pharmacyId ? `AND p.id = $2::int` : "";
    if (pharmacyId) {
      params.push(pharmacyId);
    }

    const existingResult = await pool.query<{
      id: number;
      image_url: string | null;
      logo_url: string | null;
      cover_image_url: string | null;
    }>(
      `
      SELECT p.id, p.image_url, p.logo_url, p.cover_image_url
      FROM pharmacies p
      JOIN pharmacist_pharmacies pp
        ON pp.pharmacy_id = p.id
      WHERE pp.user_id = $1
        ${pharmacyFilter}
      ORDER BY p.id ASC
      LIMIT 1
      `,
      params
    );

    const existing = existingResult.rows[0];
    if (!existing) {
      return res.status(404).json({ message: "Pharmacy not found" });
    }

    const { logoUpload, coverUpload } = await uploadEntityMedia(req, logoFile, coverFile, "healthlink/pharmacies");
    const nextLogoUrl = logoUpload?.secure_url ?? existing.logo_url;
    const nextCoverUrl = coverUpload?.secure_url ?? existing.cover_image_url;
    const nextImageUrl = nextCoverUrl || existing.image_url || nextLogoUrl || null;

    await pool.query(
      `
      UPDATE pharmacies
      SET
        logo_url = $1,
        logo_id = $2,
        cover_image_url = $3,
        cover_id = $4,
        image_url = $5
      WHERE id = $6
      `,
      [
        nextLogoUrl,
        logoUpload?.public_id ?? null,
        nextCoverUrl,
        coverUpload?.public_id ?? null,
        nextImageUrl,
        existing.id,
      ]
    );

    return res.json({
      success: true,
      data: {
        logoUrl: nextLogoUrl,
        logoId: logoUpload?.public_id ?? null,
        coverUrl: nextCoverUrl,
        coverId: coverUpload?.public_id ?? null,
        imageUrl: nextImageUrl,
        pharmacyId: existing.id,
      },
    });
  } catch (error) {
    console.error("PHARMACY IMAGE UPLOAD ERROR:", error);
    const statusCode = Number((error as { statusCode?: number })?.statusCode) || 500;
    return res.status(statusCode).json({
      message: statusCode === 403 ? "Only pharmacists can upload images" : "Pharmacy image upload failed",
    });
  }
};
