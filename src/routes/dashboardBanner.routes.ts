import { Router } from "express";
import {
  createDashboardBannerController,
  deleteDashboardBannerController,
  getAdminDashboardBannersController,
  getPatientDashboardBannersController,
  updateDashboardBannerController,
} from "../controllers/dashboardBanner.controller";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireRole } from "../middleware/requireRole";
import { upload } from "../middleware/upload";

export const adminDashboardBannerRoutes = Router();

adminDashboardBannerRoutes.use(authenticateToken, requireRole("admin"));
adminDashboardBannerRoutes.get("/dashboard-banners", getAdminDashboardBannersController);
adminDashboardBannerRoutes.post(
  "/dashboard-banners",
  upload.single("image"),
  createDashboardBannerController
);
adminDashboardBannerRoutes.put(
  "/dashboard-banners/:id",
  upload.single("image"),
  updateDashboardBannerController
);
adminDashboardBannerRoutes.delete("/dashboard-banners/:id", deleteDashboardBannerController);

export const patientDashboardBannerRoutes = Router();

patientDashboardBannerRoutes.use(authenticateToken);
patientDashboardBannerRoutes.get("/dashboard-banners", getPatientDashboardBannersController);
