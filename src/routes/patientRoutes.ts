import express from "express";
import authMiddleware from "../middleware/authMiddleware";
import {
  cancelBooking,
  createBooking,
  getBookings,
  getDoctorBookings,
  rescheduleBooking,
} from "../controllers/patientBooking.controller";
import { getMe, updateMe } from "../controllers/patientProfile.controller";
import {
  getDoctorAvailability,
  getDoctorProfile,
  getDoctorQueueStatus,
  getDoctorWorkingDays,
  getDoctors,
  joinQueue,
} from "../controllers/patientDoctor.controller";
import {
  getPrescriptionDetail,
  getPrescriptions,
  markPrescriptionSeen,
} from "../controllers/patientPrescription.controller";
import {
  buildPrescriptionCartController,
  createPrescriptionOrderController,
} from "../modules/prescriptionCommerce/controller";
import { getPatientPharmacies } from "../controllers/patientPharmacy.controller";
import { getMedicalHistory } from "../controllers/patientMedicalHistory.controller";
import { addPatient, getAllPatients } from "../controllers/patient.controller";

const router = express.Router();


// ✅ Fetch all patients
router.get("/", getAllPatients);
// ✅ Add a new patient
router.post("/", addPatient);
// GET /patient/profile
router.get("/me", authMiddleware, getMe);
router.put("/me", authMiddleware, updateMe);

// ✅ Fetch doctor availability for patients
router.get("/doctor/availability/:doctorId", authMiddleware, getDoctorAvailability);

// ✅ Fetch doctor working days for patients
router.get("/doctor/working-days/:doctorId", authMiddleware, getDoctorWorkingDays);

// ✅ Fetch today's queue status for a doctor (patient view)
router.get("/doctor/queue-status/:doctorId", authMiddleware, getDoctorQueueStatus);

// ✅ Join today's queue (patient)
router.post("/queue/join", authMiddleware, joinQueue);

// ✅ Patient prescriptions (latest or list)
router.get("/prescriptions", authMiddleware, getPrescriptions);

// ✅ Patient prescription detail
router.get("/prescriptions/:id", authMiddleware, getPrescriptionDetail);

// ✅ Mark prescription as seen
router.patch("/prescriptions/:id/seen", authMiddleware, markPrescriptionSeen);
router.post("/prescriptions/:id/build-cart", authMiddleware, buildPrescriptionCartController);
router.post("/prescriptions/:id/create-order", authMiddleware, createPrescriptionOrderController);

// ✅ Patient medical history
router.get("/medical-history", authMiddleware, getMedicalHistory);

// ✅ Patient pharmacy marketplace
router.get("/pharmacies", authMiddleware, getPatientPharmacies);

// ✅ Fetch doctors list for patients
router.get("/doctors", authMiddleware, getDoctors);
router.get("/doctors/:doctorId", authMiddleware, getDoctorProfile);

// ✅ Fetch patient bookings (upcoming + past)
router.get("/bookings", authMiddleware, getBookings);

// ✅ Cancel a booking (patient)
router.patch("/bookings/:id/cancel", authMiddleware, cancelBooking);

// ✅ Reschedule a booking (patient)
router.patch("/bookings/:id/reschedule", authMiddleware, rescheduleBooking);

// ✅ Fetch booked slots for a doctor/date (patient view)
router.get("/doctor/bookings/:doctorId", authMiddleware, getDoctorBookings);

// ✅ Book a slot (patient)
router.post("/bookings", authMiddleware, createBooking);

export default router;
