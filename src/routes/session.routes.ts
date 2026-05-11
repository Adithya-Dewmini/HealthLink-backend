import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  createCenterSessionController,
  getDoctorScheduleController,
} from "../controllers/session.controller";

export const doctorSessionRoutes = express.Router();
export const centerSessionRoutes = express.Router();
export const sessionRoutes = express.Router();

doctorSessionRoutes.use(authenticateToken);
doctorSessionRoutes.get("/schedule", getDoctorScheduleController);

centerSessionRoutes.use(authenticateToken);
centerSessionRoutes.post("/:centerId/sessions", createCenterSessionController);
