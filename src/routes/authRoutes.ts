import { Router } from "express";
import multer from "multer";
import { registerUser } from "../controllers/authController";
import {
  forgotPassword,
  loginUser,
  logoutUser,
  resetPassword,
  setPassword,
  validateResetToken,
} from "../controllers/auth.controller";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  registerMedicalCenterWithVerificationController,
  registerPharmacyWithVerificationController,
} from "../controllers/entityRegistration.controller";
import {
  authLoginRateLimit,
  authSetPasswordRateLimit,
} from "../middleware/rateLimit";

const router = Router();
const registrationUpload = multer({
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

// POST /auth/register
router.post("/register", registerUser);
router.post(
  "/register-medical-center",
  registrationUpload.fields([{ name: "verification_document", maxCount: 1 }]),
  registerMedicalCenterWithVerificationController
);
router.post(
  "/register-pharmacy",
  registrationUpload.fields([{ name: "verification_document", maxCount: 1 }]),
  registerPharmacyWithVerificationController
);

// POST /auth/login
router.post("/login", authLoginRateLimit, loginUser);
router.post("/logout", authenticateToken, logoutUser);

// POST /auth/set-password
router.post("/set-password", authSetPasswordRateLimit, setPassword);

// POST /auth/forgot-password
router.post("/forgot-password", authSetPasswordRateLimit, forgotPassword);

// POST /auth/reset-password
router.post("/reset-password", authSetPasswordRateLimit, resetPassword);

// POST /auth/validate-reset-token
router.post("/validate-reset-token", authSetPasswordRateLimit, validateResetToken);

export default router;
