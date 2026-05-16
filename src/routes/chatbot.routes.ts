import express from "express";
import authMiddleware from "../middleware/authMiddleware";
import { sendPatientChatbotMessage } from "../controllers/chatbot.controller";

const router = express.Router();

router.post("/chatbot/message", authMiddleware, sendPatientChatbotMessage);

export default router;
