import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  bookSessionController,
  completeSessionController,
  createCenterSessionController,
  getDoctorScheduleController,
  getSessionByIdController,
  joinSessionController,
  missSessionController,
  nextSessionController,
} from "../controllers/session.controller";

export const doctorSessionRoutes = express.Router();
export const centerSessionRoutes = express.Router();
export const sessionRoutes = express.Router();

doctorSessionRoutes.use(authenticateToken);
doctorSessionRoutes.get("/schedule", getDoctorScheduleController);

centerSessionRoutes.use(authenticateToken);
centerSessionRoutes.post("/:centerId/sessions", createCenterSessionController);

sessionRoutes.use(authenticateToken);
sessionRoutes.get("/sessions/:id", getSessionByIdController);
sessionRoutes.post("/sessions/:id/book", bookSessionController);
sessionRoutes.post("/sessions/:id/join", joinSessionController);
sessionRoutes.post("/sessions/:id/next", nextSessionController);
sessionRoutes.post("/sessions/:id/complete", completeSessionController);
sessionRoutes.post("/sessions/:id/missed", missSessionController);
