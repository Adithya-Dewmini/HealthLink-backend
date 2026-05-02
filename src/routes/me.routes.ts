import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { getMeContextController } from "../controllers/me.controller";

const router = express.Router();

router.use(authenticateToken);
router.get("/context", getMeContextController);

export default router;
