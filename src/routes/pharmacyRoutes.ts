import express from "express";
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
  getPrescriptionByIdController,
  getPrescriptionByQrController,
  restockMedicineController,
  updateMedicineController,
} from "../modules/pharmacy/controller";

const router = express.Router();

router.get("/categories", getCategoriesController);
router.post("/categories", createCategoryController);
router.get("/brands", getBrandsController);
router.post("/brands", createBrandController);
router.get("/inventory", getInventoryController);
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

export default router;
