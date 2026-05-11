import express from "express";
import { authenticateToken } from "../../middleware/authenticateToken";
import { getMyActivityFeedController } from "./controller";

const router = express.Router();

router.use(authenticateToken);
router.get("/my-feed", getMyActivityFeedController);

export default router;
