import type { Server } from "socket.io";
import type { OrderSummary } from "../modules/orders/types";

let socketServer: Server | null = null;

export const attachRealtimeServer = (io: Server) => {
  socketServer = io;
};

export const orderRoom = (orderId: number | string) => `order:${orderId}`;
export const pharmacyRoom = (pharmacyId: number | string) => `pharmacy:${pharmacyId}`;
export const patientRoom = (patientId: number | string) => `patient:${patientId}`;
export const userRoom = (userId: number | string) => `user:${userId}`;

export const emitOrderUpdated = (order: OrderSummary) => {
  if (!socketServer) return;
  const payload = {
    orderId: order.id,
    patientId: order.patientId,
    pharmacyId: order.pharmacyId,
    status: order.status,
    order,
    updatedAt: order.updatedAt,
  };

  socketServer.to(orderRoom(order.id)).emit("order.updated", payload);
  socketServer.to(pharmacyRoom(order.pharmacyId)).emit("order.updated", payload);
  socketServer.to(patientRoom(order.patientId)).emit("order.updated", payload);
};

export const emitPrescriptionUpdated = (payload: {
  prescriptionId: string | number;
  patientId?: number | string | null;
  pharmacyId?: number | string | null;
  orderId?: number | string | null;
  status: string;
  metadata?: Record<string, unknown>;
}) => {
  if (!socketServer) return;
  socketServer.emit("prescription.updated", {
    prescriptionId: String(payload.prescriptionId),
    orderId: payload.orderId ?? null,
    pharmacyId: payload.pharmacyId ?? null,
    patientId: payload.patientId ?? null,
    status: payload.status,
    metadata: payload.metadata ?? {},
    updatedAt: new Date().toISOString(),
  });
};

export const emitQueueUpdated = (payload: Record<string, unknown>) => {
  if (!socketServer) return;
  socketServer.emit("queue.updated", {
    ...payload,
    updatedAt: new Date().toISOString(),
  });
};

export const emitNotificationCreated = (payload: {
  userId: number | string;
  notification: Record<string, unknown>;
}) => {
  if (!socketServer) return;
  socketServer.to(userRoom(payload.userId)).emit("notification.created", {
    userId: Number(payload.userId),
    notification: payload.notification,
    createdAt: new Date().toISOString(),
  });
};
