import express from "express";
import axios from "axios";
import { env } from "../config/env";

const router = express.Router();

router.post("/symptom-check", async (req, res) => {
  try {
    const { symptoms } = req.body;

    console.log("SYMPTOMS:", symptoms);

    const prompt = `
You are a medical assistant.

Based on these symptoms: "${symptoms}"

Return ONLY JSON like this:
{
  "specialist": "Cardiologist",
  "reason": "Short explanation",
  "urgency": "low | medium | high"
}
`;

    if (!env.geminiApiKey) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.geminiApiKey}`,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      }
    );

    const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    console.log("AI RAW:", text);

    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) throw new Error("No JSON found");

    const parsed = JSON.parse(jsonMatch[0]);

    res.json(parsed);
  } catch (error: any) {
    console.error("AI ERROR FULL:", error.response?.data || error.message);

    res.status(500).json({
      specialist: "General Physician",
      reason: "AI failed. Try again.",
      urgency: "low",
    });
  }
});

export default router;
