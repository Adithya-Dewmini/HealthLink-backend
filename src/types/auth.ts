import type { Request } from "express";
import type { JwtPayload } from "../utils/security";

export type AuthenticatedRequest<TBody = Record<string, unknown>> = Request<
  Record<string, string>,
  unknown,
  TBody
> & {
  user?: JwtPayload;
  medicalCenterId?: string;
};

export type LoginRequestBody = {
  email?: string;
  password?: string;
  expoPushToken?: string;
};

export type SetPasswordRequestBody = {
  token?: string;
  password?: string;
};

export type ResetPasswordRequestBody = {
  token?: string;
  password?: string;
};

export type RegisterRequestBody = {
  name?: string;
  email?: string;
  password?: string;
  role?: string;
  phone?: string;
  dob?: string;
  gender?: string;
  bloodGroup?: string;
  allergies?: string;
  conditions?: string;
  emergencyName?: string;
  emergencyPhone?: string;
  nic?: string;
  address?: string;
  city?: string;
  slmcNumber?: string;
  specialization?: string;
  medicalCenterName?: string;
  medicalCenterAddress?: string;
  medicalCenterPhone?: string;
  medicalCenterEmail?: string;
  medicalCenterId?: string;
};

export type RegisterMedicalCenterRequestBody = {
  centerName?: string;
  location?: string;
  address?: string;
  phone?: string;
  centerEmail?: string;
  adminName?: string;
  adminEmail?: string;
  password?: string;
  specialties?: string[] | string;
};
