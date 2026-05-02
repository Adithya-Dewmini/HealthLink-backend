import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  createDoctorAvailabilityController,
  getDoctorAvailabilityController,
  replaceDoctorAvailabilityController,
} from "../controllers/availability.controller";

const router = express.Router();

router.use(authenticateToken);
router.get("/availability", getDoctorAvailabilityController);
router.post("/availability", createDoctorAvailabilityController);
router.put("/availability", replaceDoctorAvailabilityController);

export default router;
