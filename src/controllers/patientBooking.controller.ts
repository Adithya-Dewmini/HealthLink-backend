import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import {
  parsePositiveId,
  validateBookingMutationPayload,
} from "../modules/appointments/validation";
import {
  cancelPatientBooking,
  createPatientBooking,
  listDoctorBookedSlots,
  listPatientBookings,
  reschedulePatientBooking,
} from "../services/patientBooking.service";

type BookingMutationBody = {
  doctor_id?: number | string;
  date?: string;
  time?: string;
};

type HttpError = Error & { statusCode?: number };

const requirePatientUser = (req: AuthenticatedRequest) => {
  const role = req.user?.role;
  const patientId = req.user?.id;

  if (role !== "patient" && role !== "user") {
    throw Object.assign(new Error("Only patients can access this resource"), {
      statusCode: 403,
    });
  }

  if (!patientId) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }

  return patientId;
};

const handleControllerError = (res: Response, error: unknown, fallbackMessage: string) => {
  const appError = error as HttpError;
  const statusCode = Number(appError?.statusCode) || 500;

  return res.status(statusCode).json({
    message: appError?.message || fallbackMessage,
  });
};

export const getBookings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const patientId = requirePatientUser(req);
    const bookings = await listPatientBookings(patientId);
    return res.json(bookings);
  } catch (error) {
    console.error("Error fetching patient bookings:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const cancelBooking = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const patientId = requirePatientUser(req);
    const bookingId = parsePositiveId(req.params.id);

    if (!bookingId) {
      return res.status(400).json({ message: "Invalid booking id" });
    }

    await cancelPatientBooking(patientId, bookingId);
    return res.json({ message: "Booking cancelled" });
  } catch (error) {
    console.error("Error cancelling booking:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const rescheduleBooking = async (
  req: AuthenticatedRequest<BookingMutationBody>,
  res: Response
) => {
  try {
    const patientId = requirePatientUser(req);
    const bookingId = parsePositiveId(req.params.id);
    const { date, time } = req.body || {};

    if (!bookingId) {
      return res.status(400).json({ message: "Invalid booking id" });
    }

    const payloadValidation = validateBookingMutationPayload(date, time);
    if (payloadValidation.ok === false) {
      return res.status(400).json({ message: payloadValidation.message });
    }

    await reschedulePatientBooking(patientId, bookingId, String(date), String(time));
    return res.json({ message: "Booking rescheduled" });
  } catch (error) {
    console.error("Error rescheduling booking:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const getDoctorBookings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.role !== "patient") {
      return res.status(403).json({ message: "Only patients can access bookings" });
    }

    const { doctorId } = req.params;
    const date = typeof req.query.date === "string" ? req.query.date : undefined;

    if (!date) {
      return res.status(400).json({ message: "date is required (YYYY-MM-DD)" });
    }

    const rows = await listDoctorBookedSlots(doctorId, date);
    return res.json(rows);
  } catch (error) {
    console.error("Error fetching bookings:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};

export const createBooking = async (
  req: AuthenticatedRequest<BookingMutationBody>,
  res: Response
) => {
  try {
    const patientId = requirePatientUser(req);
    const { doctor_id, date, time } = req.body || {};

    if (!doctor_id || !date || !time) {
      return res.status(400).json({ message: "doctor_id, date, time are required" });
    }

    const doctorId = parsePositiveId(doctor_id);
    if (!doctorId) {
      return res.status(400).json({ message: "Invalid doctor_id" });
    }

    const payloadValidation = validateBookingMutationPayload(date, time);
    if (payloadValidation.ok === false) {
      return res.status(400).json({ message: payloadValidation.message });
    }

    const booking = await createPatientBooking(patientId, doctorId, String(date), String(time));

    return res.json({
      message: "Booked successfully",
      booking,
    });
  } catch (error) {
    console.error("Error booking slot:", error);
    return handleControllerError(res, error, "Internal server error");
  }
};
