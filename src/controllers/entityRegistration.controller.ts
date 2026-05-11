import type { Request, Response } from "express";
import {
  registerMedicalCenterWithVerification,
  registerPharmacyWithVerification,
} from "../services/entityRegistration.service";

type HttpError = Error & { statusCode?: number };

const getUploadedFile = (files: Request["files"], fieldName: string) => {
  const fileList = files && !Array.isArray(files) ? files[fieldName] : undefined;
  return Array.isArray(fileList) ? fileList[0] : undefined;
};

export const registerMedicalCenterWithVerificationController = async (
  req: Request,
  res: Response
) => {
  try {
    const verificationDocument = getUploadedFile(req.files, "verification_document");

    if (!verificationDocument) {
      return res.status(400).json({ message: "Verification document is required" });
    }

    const specialtiesRaw = req.body?.specialties;
    const specialties =
      Array.isArray(specialtiesRaw)
        ? specialtiesRaw
        : typeof specialtiesRaw === "string" && specialtiesRaw.trim().length > 0
          ? specialtiesRaw.split(",").map((item) => item.trim())
          : [];

    const result = await registerMedicalCenterWithVerification({
      centerName: typeof req.body?.center_name === "string" ? req.body.center_name : "",
      location: typeof req.body?.location === "string" ? req.body.location : "",
      address: typeof req.body?.address === "string" ? req.body.address : "",
      phone: typeof req.body?.phone === "string" ? req.body.phone : "",
      centerEmail: typeof req.body?.center_email === "string" ? req.body.center_email : "",
      adminName: typeof req.body?.admin_name === "string" ? req.body.admin_name : "",
      adminEmail: typeof req.body?.admin_email === "string" ? req.body.admin_email : "",
      password: typeof req.body?.password === "string" ? req.body.password : "",
      specialties,
      verificationDocument,
    });

    return res.status(201).json(result);
  } catch (error) {
    const appError = error as HttpError;
    return res.status(Number(appError?.statusCode) || 500).json({
      message: appError?.message || "Failed to submit medical center registration",
    });
  }
};

export const registerPharmacyWithVerificationController = async (
  req: Request,
  res: Response
) => {
  try {
    const verificationDocument = getUploadedFile(req.files, "verification_document");

    if (!verificationDocument) {
      return res.status(400).json({ message: "Verification document is required" });
    }

    const result = await registerPharmacyWithVerification({
      pharmacyName: typeof req.body?.pharmacy_name === "string" ? req.body.pharmacy_name : "",
      location: typeof req.body?.location === "string" ? req.body.location : "",
      phone: typeof req.body?.phone === "string" ? req.body.phone : "",
      pharmacyEmail: typeof req.body?.pharmacy_email === "string" ? req.body.pharmacy_email : "",
      ownerName: typeof req.body?.owner_name === "string" ? req.body.owner_name : "",
      ownerEmail: typeof req.body?.owner_email === "string" ? req.body.owner_email : "",
      password: typeof req.body?.password === "string" ? req.body.password : "",
      verificationDocument,
    });

    return res.status(201).json(result);
  } catch (error) {
    const appError = error as HttpError;
    return res.status(Number(appError?.statusCode) || 500).json({
      message: appError?.message || "Failed to submit pharmacy registration",
    });
  }
};
