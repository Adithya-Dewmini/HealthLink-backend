import type { Request, Response } from "express";
import { analyzePrescriptionImage } from "../services/upload.service";

export const uploadPrescription = async (req: Request, res: Response) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "No image uploaded" });
    }

    console.log("UPLOADED FILE:", file.originalname);
    const data = await analyzePrescriptionImage(file);

    return res.json({
      message: "Analysis complete",
      fileName: file.originalname,
      data,
    });
  } catch (error) {
    console.error("UPLOAD ERROR:", error);
    return res.status(500).json({ message: "Analysis failed" });
  }
};
