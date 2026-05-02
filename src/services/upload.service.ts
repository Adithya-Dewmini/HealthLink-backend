import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env";

const getGenAI = () => {
  if (!env.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  return new GoogleGenerativeAI(env.geminiApiKey);
};

export const analyzePrescriptionImage = async (file: Express.Multer.File) => {
  const base64Image = file.buffer.toString("base64");
  const model = getGenAI().getGenerativeModel({
    model: "gemini-2.5-flash",
  });

  const result = await model.generateContent([
    {
      inlineData: {
        data: base64Image,
        mimeType: file.mimetype,
      },
    },
    `
You are a medical assistant.

Analyze this prescription image and extract:

- Medicine names
- Dosage (if available)
- Frequency (if available)

Return ONLY JSON in this format:

{
  "medicines": [
    {
      "name": "Paracetamol",
      "dosage": "500mg",
      "frequency": "Twice daily"
    }
  ]
}

If unclear, make best guess.
Do NOT include explanations.
`,
  ]);

  const text = result.response.text();

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};
