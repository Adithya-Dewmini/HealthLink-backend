import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

export type JwtCenterMembership = {
  id: string;
  role: string;
};

export type JwtReceptionistPermissions = {
  can_manage_queue: boolean;
  can_manage_appointments: boolean;
  can_check_in: boolean;
};

export type JwtPayload = {
  id: number;
  email: string;
  role: string;
  medicalCenterId: string | null;
  centers: JwtCenterMembership[];
  receptionistPermissions?: JwtReceptionistPermissions;
};

const getJwtSecret = () => env.jwtSecret;

export const sha256 = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

export const generateToken = () => crypto.randomBytes(32).toString("hex");

export const hashToken = async (token: string) => bcrypt.hash(token, 10);

export const compareToken = async (inputToken: string, hashedToken: string) =>
  bcrypt.compare(inputToken, hashedToken);

export const hashPassword = async (password: string) => bcrypt.hash(password, 10);

export const comparePassword = async (password: string, passwordHash: string) =>
  bcrypt.compare(password, passwordHash);

export const extractBearerToken = (authorizationHeader: unknown): string | null => {
  if (typeof authorizationHeader !== "string") {
    return null;
  }

  const [scheme, token] = authorizationHeader.trim().split(/\s+/);
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
};

export const signAuthToken = (payload: JwtPayload) =>
  jwt.sign(payload, getJwtSecret(), {
    expiresIn: "7d",
  });

export const verifyAuthToken = (token: string) =>
  jwt.verify(token, getJwtSecret()) as JwtPayload;
