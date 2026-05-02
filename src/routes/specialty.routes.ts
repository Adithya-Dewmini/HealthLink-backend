import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  checkActiveUserInCenter,
  requireMedicalCenterAdmin,
} from "../middleware/medicalCenterScope";
import {
  createSpecialtyController,
  deleteSpecialtyController,
  listSpecialtiesController,
  updateSpecialtyController,
} from "../controllers/specialty.controller";

const router = express.Router();

router.use(authenticateToken, requireMedicalCenterAdmin, checkActiveUserInCenter);

router.get("/", listSpecialtiesController);
router.post("/", createSpecialtyController);
router.put("/:id", updateSpecialtyController);
router.delete("/:id", deleteSpecialtyController);

export default router;
