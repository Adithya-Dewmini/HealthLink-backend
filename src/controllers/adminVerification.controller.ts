import type { RequestHandler } from "express";

const unavailable: RequestHandler = (_req, res) => {
  return res.status(503).json({ message: "Admin verification endpoints are temporarily disabled" });
};

export const approveVerificationController = unavailable;
export const getVerificationDetailController = unavailable;
export const listVerificationsController = unavailable;
export const rejectVerificationController = unavailable;
export const addVerificationNoteController = unavailable;
