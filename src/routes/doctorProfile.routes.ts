import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";

const router = express.Router();

router.use(authenticateToken);

export default router;
