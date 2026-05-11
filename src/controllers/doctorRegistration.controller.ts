import type { Request, Response } from "express";
import { registerDoctorWithVerification } from "../services/doctorRegistration.service";

type HttpError = Error & { statusCode?: number };

const getUploadedFile = (files: Request["files"], fieldName: string) => {
  const fileList = files && !Array.isArray(files) ? files[fieldName] : undefined;
  return Array.isArray(fileList) ? fileList[0] : undefined;
};

export const registerDoctorController = async (req: Request, res: Response) => {
  try {
    const slmcCertificate = getUploadedFile(req.files, "slmc_certificate");
    const degreeCertificate = getUploadedFile(req.files, "degree_certificate");
    const idProof = getUploadedFile(req.files, "id_proof");

    if (!slmcCertificate || !degreeCertificate || !idProof) {
      return res.status(400).json({
        message: "SLMC certificate, degree certificate, and ID proof are required",
      });
    }

    const result = await registerDoctorWithVerification({
      fullName: typeof req.body?.full_name === "string" ? req.body.full_name : "",
      nic: typeof req.body?.nic === "string" ? req.body.nic : "",
      email: typeof req.body?.email === "string" ? req.body.email : "",
      phone: typeof req.body?.phone === "string" ? req.body.phone : "",
      slmcNumber: typeof req.body?.slmc_number === "string" ? req.body.slmc_number : "",
      qualification: typeof req.body?.qualification === "string" ? req.body.qualification : "",
      specialization: typeof req.body?.specialization === "string" ? req.body.specialization : "",
      experienceYears:
        typeof req.body?.experience_years === "string" || typeof req.body?.experience_years === "number"
          ? Number(req.body.experience_years)
          : 0,
      workplace: typeof req.body?.workplace === "string" ? req.body.workplace : "",
      password: typeof req.body?.password === "string" ? req.body.password : "",
      slmcCertificate,
      degreeCertificate,
      idProof,
    });

    return res.status(201).json(result);
  } catch (error) {
    const appError = error as HttpError;
    return res.status(Number(appError?.statusCode) || 500).json({
      message: appError?.message || "Failed to submit doctor registration",
    });
  }
};
