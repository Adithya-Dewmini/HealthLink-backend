import type { RequestHandler, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { updateDoctorClinicSpecialty } from "../services/doctorAssociation.service";

type UpdateDoctorClinicBody = {
  clinic_specialty_id?: string | null;
};

type CenterActionRequest<TBody = Record<string, unknown>> = AuthenticatedRequest<TBody> & {
  medicalCenterId: string;
  params: {
    id: string;
  };
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as Error & { statusCode?: number };
  return res.status(Number(appError?.statusCode) || 500).json({
    message: appError?.message || fallbackMessage,
  });
};

export const updateDoctorClinicController: RequestHandler = async (req, res: Response) => {
  const typedReq = req as CenterActionRequest<UpdateDoctorClinicBody>;

  try {
    const result = await updateDoctorClinicSpecialty({
      medicalCenterId: typedReq.medicalCenterId,
      relationshipId: typedReq.params.id,
      clinicSpecialtyId:
        typeof typedReq.body?.clinic_specialty_id === "string" &&
        typedReq.body.clinic_specialty_id.trim().length > 0
          ? typedReq.body.clinic_specialty_id.trim()
          : null,
    });

    return res.status(200).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to update doctor clinic settings");
  }
};
