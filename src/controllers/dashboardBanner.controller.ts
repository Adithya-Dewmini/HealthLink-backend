import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  createDashboardBanner,
  deleteDashboardBanner,
  listAdminDashboardBanners,
  listPatientDashboardBanners,
  updateDashboardBanner,
  uploadDashboardBannerImage,
  type DashboardBannerInput,
} from "../services/dashboardBanner.service";

const asTrimmedString = (value: unknown) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
};

const asBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
};

const asInteger = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const asDateInput = (value: unknown) => {
  const raw = asTrimmedString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const parseBannerInput = (body: Record<string, unknown>): DashboardBannerInput => ({
  title: asTrimmedString(body.title),
  subtitle: asTrimmedString(body.subtitle),
  targetType: asTrimmedString(body.targetType) ?? asTrimmedString(body.target_type) ?? "none",
  targetId: asTrimmedString(body.targetId) ?? asTrimmedString(body.target_id),
  targetScreen: asTrimmedString(body.targetScreen) ?? asTrimmedString(body.target_screen),
  isActive: asBoolean(body.isActive ?? body.is_active, true),
  sortOrder: asInteger(body.sortOrder ?? body.sort_order, 0),
  startDate: asDateInput(body.startDate ?? body.start_date),
  endDate: asDateInput(body.endDate ?? body.end_date),
});

const validateBannerInput = (input: DashboardBannerInput) => {
  if (input.startDate && input.endDate && new Date(input.startDate) > new Date(input.endDate)) {
    return "Start date must be before end date";
  }

  return null;
};

export const getAdminDashboardBannersController = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const items = await listAdminDashboardBanners();
    return res.json({ items });
  } catch (error) {
    console.error("GET ADMIN DASHBOARD BANNERS ERROR:", error);
    return res.status(500).json({ message: "Unable to load dashboard banners" });
  }
};

export const getPatientDashboardBannersController = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const items = await listPatientDashboardBanners();
    return res.json({
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        imageUrl: item.imageUrl,
        targetType: item.targetType,
        targetId: item.targetId,
        targetScreen: item.targetScreen,
      })),
    });
  } catch (error) {
    console.error("GET PATIENT DASHBOARD BANNERS ERROR:", error);
    return res.status(500).json({ message: "Unable to load dashboard banners" });
  }
};

export const createDashboardBannerController = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = parseBannerInput(req.body ?? {});
    const validationError = validateBannerInput(input);
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    if (!req.file) {
      return res.status(400).json({ message: "Banner image is required" });
    }

    const uploaded = await uploadDashboardBannerImage(req, req.file);
    const banner = await createDashboardBanner(input, uploaded.secureUrl, req.user?.id ?? null);
    return res.status(201).json(banner);
  } catch (error) {
    console.error("CREATE DASHBOARD BANNER ERROR:", error);
    const message = error instanceof Error ? error.message : "Unable to create dashboard banner";
    return res.status(500).json({ message });
  }
};

export const updateDashboardBannerController = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = parseBannerInput(req.body ?? {});
    const validationError = validateBannerInput(input);
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const uploaded = req.file ? await uploadDashboardBannerImage(req, req.file) : null;
    const banner = await updateDashboardBanner(req.params.id, input, uploaded?.secureUrl);
    if (!banner) {
      return res.status(404).json({ message: "Dashboard banner not found" });
    }

    return res.json(banner);
  } catch (error) {
    console.error("UPDATE DASHBOARD BANNER ERROR:", error);
    const message = error instanceof Error ? error.message : "Unable to update dashboard banner";
    return res.status(500).json({ message });
  }
};

export const deleteDashboardBannerController = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const deleted = await deleteDashboardBanner(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Dashboard banner not found" });
    }

    return res.json({ id: deleted.id });
  } catch (error) {
    console.error("DELETE DASHBOARD BANNER ERROR:", error);
    return res.status(500).json({ message: "Unable to delete dashboard banner" });
  }
};
