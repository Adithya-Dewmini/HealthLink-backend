import type { JwtPayload } from "../utils/security";

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      medicalCenterId?: string;
    }
  }
}

export {};
