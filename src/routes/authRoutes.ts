import { Router } from "express";
import { registerUser } from "../controllers/authController";
import {
  forgotPassword,
  loginUser,
  resetPassword,
  setPassword,
  validateResetToken,
} from "../controllers/auth.controller";
import {
  authLoginRateLimit,
  authSetPasswordRateLimit,
} from "../middleware/rateLimit";

const router = Router();

// POST /auth/register
router.post("/register", registerUser);

// POST /auth/login
router.post("/login", authLoginRateLimit, loginUser);

// POST /auth/set-password
router.post("/set-password", authSetPasswordRateLimit, setPassword);

// POST /auth/forgot-password
router.post("/forgot-password", authSetPasswordRateLimit, forgotPassword);

// POST /auth/reset-password
router.post("/reset-password", authSetPasswordRateLimit, resetPassword);

// POST /auth/validate-reset-token
router.post("/validate-reset-token", authSetPasswordRateLimit, validateResetToken);

export default router;
