import { Router } from "express";
import multer from "multer";
import { registerDoctorController } from "../controllers/doctorRegistration.controller";

const router = Router();
const adminRouter = Router();

const doctorRegistrationUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (_req, file, callback) => {
    const mimeType = String(file.mimetype || "").toLowerCase();
    if (mimeType === "application/pdf" || mimeType.startsWith("image/")) {
      callback(null, true);
      return;
    }

    callback(new Error("Only PDF or image files are allowed"));
  },
});

router.post(
  "/register",
  doctorRegistrationUpload.fields([
    { name: "slmc_certificate", maxCount: 1 },
    { name: "degree_certificate", maxCount: 1 },
    { name: "id_proof", maxCount: 1 },
  ]),
  registerDoctorController
);

export { router as doctorRegistrationRoutes, adminRouter as adminDoctorRegistrationRoutes };
