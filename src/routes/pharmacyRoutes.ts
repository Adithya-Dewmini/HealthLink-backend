import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  createBrandController,
  createCategoryController,
  createMedicineController,
  createDemandLogController,
  createSaleController,
  deleteMedicineController,
  dispensePrescriptionByIdController,
  dispensePrescriptionController,
  getBrandsController,
  getCategoriesController,
  getInventoryController,
  getPharmacyProfileController,
  getPrescriptionByIdController,
  getPrescriptionByQrController,
  restockMedicineController,
  updateMedicineController,
} from "../modules/pharmacy/controller";
import {
  createMarketplaceProductController,
  updateMarketplaceProductController,
  updateMarketplaceProductVisibilityController,
} from "../modules/marketplace/controller";
import {
  createOrderFromScanController,
  scanPrescriptionForOrderController,
} from "../modules/prescriptionCommerce/controller";
import {
  getPharmacyOrderController,
  getPharmacyOrdersController,
  getPharmacyOrderTimelineController,
  completePharmacyOrderController,
  rejectPharmacyOrderController,
  reviewPharmacyOrderController,
  updatePharmacyOrderStatusController,
} from "../modules/orders/controller";
import {
  getPharmacyAnalyticsDashboardController,
  getPharmacyForecastController,
} from "../modules/pharmacyAnalytics/controller";

const router = express.Router();

router.use(authenticateToken);
router.get("/profile", getPharmacyProfileController);
router.get("/categories", getCategoriesController);
router.post("/categories", createCategoryController);
router.get("/brands", getBrandsController);
router.post("/brands", createBrandController);
router.get("/inventory", getInventoryController);
router.get("/prescriptions/scan/:qrToken", scanPrescriptionForOrderController);
router.post("/prescriptions/:id/create-order-from-scan", createOrderFromScanController);
router.get("/prescriptions/:id", getPrescriptionByIdController);
router.get("/prescription/:qrToken", getPrescriptionByQrController);
router.post("/dispense/:prescriptionId", dispensePrescriptionByIdController);
router.post("/dispense", dispensePrescriptionController);
router.post("/sale", createSaleController);
router.post("/demand-log", createDemandLogController);
router.post("/medicine", createMedicineController);
router.put("/medicines/:id", updateMedicineController);
router.patch("/medicines/:id/restock", restockMedicineController);
router.delete("/medicines/:id", deleteMedicineController);
router.post("/marketplace/products", createMarketplaceProductController);
router.patch("/marketplace/products/:id", updateMarketplaceProductController);
router.patch("/marketplace/products/:id/visibility", updateMarketplaceProductVisibilityController);
router.get("/orders", getPharmacyOrdersController);
router.get("/orders/:id", getPharmacyOrderController);
router.get("/orders/:id/timeline", getPharmacyOrderTimelineController);
router.post("/orders/:id/review", reviewPharmacyOrderController);
router.patch("/orders/:id/reject", rejectPharmacyOrderController);
router.post("/orders/:id/complete", completePharmacyOrderController);
router.patch("/orders/:id/status", updatePharmacyOrderStatusController);
router.get("/analytics/dashboard", getPharmacyAnalyticsDashboardController);
router.get("/analytics/forecast/:medicineId", getPharmacyForecastController);

export default router;
