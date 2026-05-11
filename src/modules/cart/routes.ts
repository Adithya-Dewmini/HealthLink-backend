import express from "express";
import { authenticateToken } from "../../middleware/authenticateToken";
import {
  addCartItemController,
  deleteCartItemController,
  getCartController,
  updateCartItemController,
} from "./controller";

const router = express.Router();

router.use(authenticateToken);
router.get("/", getCartController);
router.post("/items", addCartItemController);
router.patch("/items/:id", updateCartItemController);
router.delete("/items/:id", deleteCartItemController);

export default router;
