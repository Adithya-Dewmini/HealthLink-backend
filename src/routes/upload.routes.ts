import express from "express";
import authMiddleware from "../middleware/authMiddleware";
import { upload } from "../middleware/upload";
import {
  uploadClinicImages,
  uploadPharmacyImages,
  uploadPrescription,
  uploadProfileImage,
} from "../controllers/upload.controller";

const router = express.Router();

router.post("/prescription", upload.single("image"), uploadPrescription);
router.post("/profile", authMiddleware, upload.single("image"), uploadProfileImage);
router.post(
  "/clinic",
  authMiddleware,
  upload.fields([
    { name: "logo", maxCount: 1 },
    { name: "cover", maxCount: 1 },
  ]),
  uploadClinicImages
);
router.post(
  "/pharmacy",
  authMiddleware,
  upload.fields([
    { name: "logo", maxCount: 1 },
    { name: "cover", maxCount: 1 },
  ]),
  uploadPharmacyImages
);

export default router;
