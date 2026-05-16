import http from "http";
import { Server } from "socket.io";
import express from "express";  
import axios from "axios";
import path from "path";
import pool, { initDb } from "./config/db"; // ✅ initialize DB before starting server
import { env } from "./config/env";
import { startQueueAutoEnd } from "./jobs/queueAutoEnd";
import { startRoutineSessionGenerationJob } from "./jobs/sessionGeneration";
import { errorHandler } from "./middleware/errorHandler";
import { requestLogger } from "./middleware/requestLogger";
import { sanitizeInput } from "./middleware/sanitizeInput";
import { apiRateLimiter, corsMiddleware, securityHeaders } from "./middleware/security";
import { clinicPublicRoom } from "./services/clinicRealtime.service";
import {
  attachRealtimeServer,
  orderRoom,
  patientRoom,
  pharmacyRoom,
  userRoom,
} from "./services/realtime.service";
import { extractBearerToken, verifyAuthToken, type JwtPayload } from "./utils/security";
console.log("GEMINI KEY LOADED:", Boolean(env.geminiApiKey));

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

export const app = express();

app.use(securityHeaders);
app.use(corsMiddleware);
app.use(requestLogger);
app.use(apiRateLimiter);
app.use(express.json());
app.use(sanitizeInput);
app.use("/uploads", express.static(path.resolve(process.cwd(), "uploads")));

app.get("/api/health", async (_req, res) => {
  const timestamp = new Date().toISOString();
  const databaseConnected = await pool.query("SELECT 1").then(() => true).catch(() => false);
  const forecastAvailable = env.forecastServiceUrl
    ? await axios
        .get(`${env.forecastServiceUrl.replace(/\/$/, "")}/health`, { timeout: 5000 })
        .then(() => true)
        .catch(() => false)
    : false;

  res.status(databaseConnected ? 200 : 503).json({
    status: databaseConnected ? "OK" : "DEGRADED",
    timestamp,
    database: databaseConnected ? "connected" : "unavailable",
    forecastService: env.forecastServiceUrl
      ? forecastAvailable
        ? "available"
        : "offline"
      : "not_configured",
    socket: "enabled",
    version: process.env.npm_package_version || "1.0.0",
  });
});

import patientRoutes from "./routes/patientRoutes";
app.use("/api/patients", patientRoutes);

import clinicRoutes from "./routes/clinic.routes";
app.use("/api/clinics", clinicRoutes);

import doctorRoutes from "./routes/doctor.routes";
app.use("/api/doctor", doctorRoutes);

import pharmacyRoutes from "./routes/pharmacyRoutes";
app.use("/api/pharmacy", pharmacyRoutes);

import marketplaceRoutes from "./modules/marketplace/routes";
app.use("/api/marketplace", marketplaceRoutes);

import cartRoutes from "./modules/cart/routes";
app.use("/api/cart", cartRoutes);

import orderRoutes from "./modules/orders/routes";
app.use("/api/orders", orderRoutes);

import paymentRoutes from "./routes/payment.routes";
app.use("/api/payments", paymentRoutes);

import notificationRoutes from "./modules/notifications/routes";
app.use("/api/notifications", notificationRoutes);
import activityRoutes from "./modules/activity/routes";
app.use("/api/activity", activityRoutes);

import authRoutes from "./routes/authRoutes";
app.use("/auth", authRoutes);
app.use("/api/auth", authRoutes);

import consultationRoutes from "./routes/consultation.routes";
app.use("/api", consultationRoutes);

import aiRoutes from "./routes/ai.routes";
app.use("/api/ai", aiRoutes);

import uploadRoutes from "./routes/upload.routes";
app.use("/api/upload", uploadRoutes);

import favoritesRoutes from "./routes/favorites.routes";
app.use("/api/favorites", favoritesRoutes);
app.use("/api/patient/favorites", favoritesRoutes);

import medicalCenterRoutes from "./routes/medicalCenter.routes";
app.use("/api/center", medicalCenterRoutes);

import {
  adminDoctorRegistrationRoutes,
  doctorRegistrationRoutes,
} from "./routes/doctorRegistration.routes";
app.use("/api/doctors", doctorRegistrationRoutes);
app.use("/api/admin", adminDoctorRegistrationRoutes);

import availabilityRoutes from "./routes/availability.routes";
app.use("/api/doctors", availabilityRoutes);

import { centerSessionRoutes, doctorSessionRoutes, sessionRoutes } from "./routes/session.routes";
app.use("/api/doctors", doctorSessionRoutes);
app.use("/api/centers", centerSessionRoutes);
app.use("/api", sessionRoutes);

import doctorClinicRoutes from "./routes/doctorClinic.routes";
app.use("/api/doctors", doctorClinicRoutes);

import doctorDirectoryRoutes from "./routes/doctorDirectory.routes";
app.use("/api/doctors", doctorDirectoryRoutes);

import doctorProfileRoutes from "./routes/doctorProfile.routes";
app.use("/api/doctors", doctorProfileRoutes);

import specialtyRoutes from "./routes/specialty.routes";
app.use("/api/clinic-specialties", specialtyRoutes);

import doctorClinicAdminRoutes from "./routes/doctorClinicAdmin.routes";
app.use("/api/doctor-clinics", doctorClinicAdminRoutes);

import meRoutes from "./routes/me.routes";
app.use("/api/me", meRoutes);

import receptionRoutes from "./routes/reception.routes";
app.use("/api/reception", receptionRoutes);

import adminVerificationRoutes from "./routes/adminVerification.routes";
app.use("/api/admin", adminVerificationRoutes);

import adminDashboardRoutes from "./routes/admin.dashboard.routes";
app.use("/api/admin", adminDashboardRoutes);

import adminMedicalCenterRoutes from "./routes/admin.medicalCenter.routes";
app.use("/api/admin", adminMedicalCenterRoutes);

import adminDoctorRoutes from "./routes/admin.doctor.routes";
app.use("/api/admin", adminDoctorRoutes);

import adminPharmacyRoutes from "./routes/admin.pharmacy.routes";
app.use("/api/admin", adminPharmacyRoutes);

import adminUserRoutes from "./routes/admin.user.routes";
app.use("/api/admin", adminUserRoutes);

// import adminUserManagementRoutes from "./routes/admin.user.management.routes";
// app.use("/api/admin", adminUserManagementRoutes);

import adminAuditRoutes from "./routes/admin.audit.routes";
app.use("/api/admin", adminAuditRoutes);

import adminMonitorRoutes from "./routes/admin.monitor.routes";
app.use("/api/admin", adminMonitorRoutes);

import {
  adminDashboardBannerRoutes,
  patientDashboardBannerRoutes,
} from "./routes/dashboardBanner.routes";
app.use("/api/admin", adminDashboardBannerRoutes);
app.use("/api/patient", patientDashboardBannerRoutes);

import chatbotRoutes from "./routes/chatbot.routes";
app.use("/api/patient", chatbotRoutes);

app.get("/", (req, res) => {
  res.send("HealthLink API running 🚀");
});

app.use(errorHandler);


const PORT = env.port;
// Create HTTP server from express app
const server = http.createServer(app);

// Attach Socket.io
export const io = new Server(server, {
  cors: {
    origin: env.allowedOrigins.length ? env.allowedOrigins : "*",
  },
});
attachRealtimeServer(io);

io.use((socket, next) => {
  try {
    const authValue =
      typeof socket.handshake.auth?.token === "string"
        ? `Bearer ${socket.handshake.auth.token}`
        : typeof socket.handshake.headers?.authorization === "string"
          ? socket.handshake.headers.authorization
          : null;

    const token = extractBearerToken(authValue);
    if (!token) {
      return next(new Error("Unauthorized"));
    }

    const user = verifyAuthToken(token);
    if (!user?.id || !user?.role) {
      return next(new Error("Unauthorized"));
    }
    socket.data.user = user;
    return next();
  } catch {
    return next(new Error("Unauthorized"));
  }
});

const getAllowedCenterIds = (user: JwtPayload) =>
  new Set<string>(
    [user.medicalCenterId, ...(user.centers ?? []).map((center) => center.id)].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    )
  );

const canJoinSessionRoom = async (user: JwtPayload, rawSessionId: unknown) => {
  const sessionId = Number(rawSessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return null;
  }

  try {
    const result = await pool.query<{
      id: number;
      doctor_user_id: number;
      medical_center_id: string;
      patient_booking_id: number | null;
      patient_queue_id: number | null;
    }>(
      `
      SELECT
        s.id,
        s.doctor_user_id,
        s.medical_center_id,
        (
          SELECT b.id
          FROM bookings b
          WHERE b.session_id = s.id
            AND b.patient_id = $2
            AND COALESCE(UPPER(b.status), '') <> 'CANCELLED'
          LIMIT 1
        ) AS patient_booking_id,
        (
          SELECT qp.id
          FROM queue_patients qp
          WHERE qp.session_id = s.id
            AND qp.patient_id = $2
          LIMIT 1
        ) AS patient_queue_id
      FROM medical_center_doctor_schedule s
      WHERE s.id = $1
      LIMIT 1
      `,
      [sessionId, user.id]
    );

    const session = result.rows[0];
    if (!session) {
      return null;
    }

    const role = String(user.role || "").toLowerCase();

    if (role === "doctor" && session.doctor_user_id === user.id) {
      return sessionId;
    }

    if ((role === "patient" || role === "user") && (session.patient_booking_id || session.patient_queue_id)) {
      return sessionId;
    }

    if (
      ["medical_center_admin", "receptionist"].includes(role) &&
      getAllowedCenterIds(user).has(session.medical_center_id)
    ) {
      return sessionId;
    }

    return null;
  } catch (error) {
    console.error("canJoinSessionRoom error:", error);
    return null;
  }
};

const getPharmacyIdForUser = async (userId: number) => {
  try {
    const result = await pool.query<{ pharmacy_id: number }>(
      `
        SELECT pharmacy_id
        FROM pharmacist_pharmacies
        WHERE user_id = $1
        ORDER BY pharmacy_id ASC
        LIMIT 1
      `,
      [userId]
    );
    return result.rows[0]?.pharmacy_id ?? null;
  } catch (error) {
    console.error("getPharmacyIdForUser error:", error);
    return null;
  }
};

io.on("connection", (socket) => {
  console.log("⚡ Client connected:", socket.id);
  const user = socket.data.user as JwtPayload | undefined;

  if (user?.id) {
    socket.join(`user_${user.id}`);
    socket.join(userRoom(user.id));
    socket.join(patientRoom(user.id));
    if (String(user.role || "").toLowerCase() === "pharmacist") {
      void (async () => {
        const ownedPharmacyId = await getPharmacyIdForUser(Number(user.id));
        if (ownedPharmacyId) {
          socket.join(pharmacyRoom(ownedPharmacyId));
        }
      })();
    }
  }

  socket.on("joinDoctorRoom", (payload: { doctorId?: number | string } | number | string) => {
    if (!user || String(user.role || "").toLowerCase() !== "doctor") {
      return;
    }
    const doctorId =
      typeof payload === "object" ? payload?.doctorId : payload;
    if (doctorId === undefined || doctorId === null || doctorId === "" || Number(doctorId) !== user.id) {
      return;
    }
    socket.join(`doctor_${doctorId}`);
    socket.join(`doctor-${doctorId}`);
  });

  socket.on("joinPatientRoom", (payload: { patientId?: number | string } | number | string) => {
    if (!user || !["patient", "user"].includes(String(user.role || "").toLowerCase())) {
      return;
    }
    const patientId =
      typeof payload === "object" ? payload?.patientId : payload;
    if (patientId === undefined || patientId === null || patientId === "" || Number(patientId) !== user.id) {
      return;
    }
    socket.join(`patient_${patientId}`);
    socket.join(patientRoom(patientId));
  });

  socket.on("joinOrderRoom", (payload: { orderId?: number | string } | number | string) => {
    if (!user) return;
    const orderId = typeof payload === "object" ? payload?.orderId : payload;
    if (orderId === undefined || orderId === null || orderId === "") return;
    socket.join(orderRoom(orderId));
  });

  socket.on("joinPharmacyRoom", (payload: { pharmacyId?: number | string } | number | string) => {
    if (!user || String(user.role || "").toLowerCase() !== "pharmacist") {
      return;
    }

    void (async () => {
      const requestedPharmacyId =
        typeof payload === "object" ? payload?.pharmacyId : payload;
      if (requestedPharmacyId === undefined || requestedPharmacyId === null || requestedPharmacyId === "") {
        return;
      }

      const ownedPharmacyId = await getPharmacyIdForUser(Number(user.id));
      if (!ownedPharmacyId || Number(requestedPharmacyId) !== Number(ownedPharmacyId)) {
        return;
      }
      socket.join(pharmacyRoom(ownedPharmacyId));
    })();
  });

  socket.on("joinSession", (payload: { sessionId?: number | string } | number | string) => {
    if (!user) {
      return;
    }

    void (async () => {
      try {
        const sessionId =
          typeof payload === "object" ? payload?.sessionId : payload;
        const allowedSessionId = await canJoinSessionRoom(user, sessionId);
        if (!allowedSessionId) {
          return;
        }
        socket.join(`session_${allowedSessionId}`);
      } catch (error) {
        console.error("joinSession error:", error);
      }
    })();
  });

  socket.on("joinReceptionRoom", () => {
    if (!user || String(user.role || "").toLowerCase() !== "receptionist") {
      return;
    }
    socket.join("reception");
  });

  socket.on(
    "joinCenterRoom",
    (payload: { medicalCenterId?: string } | string | null | undefined) => {
      if (!user) {
        return;
      }
      const medicalCenterId =
        typeof payload === "object" ? payload?.medicalCenterId : payload;

      if (!medicalCenterId || String(medicalCenterId).trim() === "") {
        return;
      }

      const centerId = String(medicalCenterId).trim();
      if (!getAllowedCenterIds(user).has(centerId)) {
        return;
      }

      socket.join(`center_${centerId}`);
    }
  );

  socket.on(
    "joinClinicScheduleRoom",
    (payload: { clinicId?: string } | string | null | undefined) => {
      if (!user) {
        return;
      }

      const clinicId = typeof payload === "object" ? payload?.clinicId : payload;
      if (!clinicId || String(clinicId).trim() === "") {
        return;
      }

      socket.join(clinicPublicRoom(String(clinicId).trim()));
    }
  );

  socket.on(
    "leaveClinicScheduleRoom",
    (payload: { clinicId?: string } | string | null | undefined) => {
      const clinicId = typeof payload === "object" ? payload?.clinicId : payload;
      if (!clinicId || String(clinicId).trim() === "") {
        return;
      }

      socket.leave(clinicPublicRoom(String(clinicId).trim()));
    }
  );

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

initDb()
  .then(() => {
    startQueueAutoEnd(io);
    startRoutineSessionGenerationJob();
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ Failed to start server because DB is unavailable:", err);
    process.exit(1);
  });
  
