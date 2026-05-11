import express from "express";
import { authenticateToken } from "../../middleware/authenticateToken";
import {
  getMarketplaceProductDetailsController,
  getMarketplaceStoreController,
  searchMarketplaceProductsController,
} from "./controller";

const router = express.Router();

router.use(authenticateToken);
router.get("/products/search", searchMarketplaceProductsController);
router.get("/products/:id", getMarketplaceProductDetailsController);
router.get("/pharmacies/:pharmacyId/store", getMarketplaceStoreController);

export default router;
