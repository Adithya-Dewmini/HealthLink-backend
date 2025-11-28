import { Router } from "express";
import { loginUser, registerUser } from "../controllers/authController.ts";

const router = Router();

// POST /auth/register
router.post("/register", registerUser);

// POST /auth/login
router.post("/login", loginUser);

export default router;
