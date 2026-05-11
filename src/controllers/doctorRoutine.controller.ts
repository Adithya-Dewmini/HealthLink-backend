import type { RequestHandler, Response } from "express";

const unavailable = (res: Response) =>
  res.status(503).json({ message: "Doctor routine endpoints are temporarily disabled" });

export const getDoctorRoutineController: RequestHandler = async (_req, res: Response) =>
  unavailable(res);

export const createDoctorRoutineController: RequestHandler = async (_req, res: Response) =>
  unavailable(res);
