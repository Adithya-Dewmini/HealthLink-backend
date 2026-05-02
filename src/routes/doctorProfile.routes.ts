import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  getDoctorProfileController,
  updateDoctorProfileController,
} from "../controllers/doctor.controller";

const router = express.Router();

router.get("/profile", authenticateToken, getDoctorProfileController);
router.put("/profile", authenticateToken, updateDoctorProfileController);

export default router;
