import type { Server } from "socket.io";
import type { OrderSummary } from "../modules/orders/types";

let socketServer: Server | null = null;

export const SOCKET_EVENTS = {
  queueUpdate: "queue:update",
  orderUpdate: "order:update",
  orderCreate: "order:create",
  paymentUpdate: "payment:update",
  invoiceGenerated: "invoice:generated",
  prescriptionUpdated: "prescription.updated",
  inventoryUpdated: "inventory.updated",
  notificationCreated: "notification.created",
} as const;

const isDevelopment = process.env.NODE_ENV === "development";

export const logRealtimeEmit = (
  event: string,
  room: string | null,
  payload: Record<string, unknown>
) => {
  if (!isDevelopment) return;
  console.log(
    `[socket] emit ${event}${room ? ` -> ${room}` : ""}`,
    JSON.stringify(payload)
  );
};

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

  for (const room of [
    orderRoom(order.id),
    pharmacyRoom(order.pharmacyId),
    patientRoom(order.patientId),
  ]) {
    socketServer.to(room).emit(SOCKET_EVENTS.orderUpdate, payload);
    logRealtimeEmit(SOCKET_EVENTS.orderUpdate, room, payload);
  }
};

export const emitOrderCreated = (order: OrderSummary) => {
  if (!socketServer) return;
  const payload = {
    orderId: order.id,
    patientId: order.patientId,
    pharmacyId: order.pharmacyId,
    status: order.status,
    order,
    updatedAt: order.updatedAt,
  };
  for (const room of [
    orderRoom(order.id),
    pharmacyRoom(order.pharmacyId),
    patientRoom(order.patientId),
  ]) {
    socketServer.to(room).emit(SOCKET_EVENTS.orderCreate, payload);
    logRealtimeEmit(SOCKET_EVENTS.orderCreate, room, payload);
  }
};

export const emitPaymentUpdated = (payload: {
  orderId: number | string;
  patientId: number | string;
  pharmacyId: number | string;
  paymentId: number | string;
  status: string;
  payment: Record<string, unknown>;
  invoice?: Record<string, unknown> | null;
}) => {
  if (!socketServer) return;
  const eventPayload = {
    ...payload,
    updatedAt: new Date().toISOString(),
  };

  for (const room of [
    orderRoom(payload.orderId),
    pharmacyRoom(payload.pharmacyId),
    patientRoom(payload.patientId),
  ]) {
    socketServer.to(room).emit(SOCKET_EVENTS.paymentUpdate, eventPayload);
    logRealtimeEmit(SOCKET_EVENTS.paymentUpdate, room, eventPayload);
  }
};

export const emitInvoiceGenerated = (payload: {
  orderId: number | string;
  patientId: number | string;
  pharmacyId: number | string;
  invoiceId: number | string;
  invoiceNo: string;
  invoice: Record<string, unknown>;
}) => {
  if (!socketServer) return;
  const eventPayload = {
    ...payload,
    generatedAt: new Date().toISOString(),
  };

  for (const room of [
    orderRoom(payload.orderId),
    pharmacyRoom(payload.pharmacyId),
    patientRoom(payload.patientId),
  ]) {
    socketServer.to(room).emit(SOCKET_EVENTS.invoiceGenerated, eventPayload);
    logRealtimeEmit(SOCKET_EVENTS.invoiceGenerated, room, eventPayload);
  }
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
  const eventPayload = {
    prescriptionId: String(payload.prescriptionId),
    orderId: payload.orderId ?? null,
    pharmacyId: payload.pharmacyId ?? null,
    patientId: payload.patientId ?? null,
    status: payload.status,
    metadata: payload.metadata ?? {},
    updatedAt: new Date().toISOString(),
  };
  socketServer.emit(SOCKET_EVENTS.prescriptionUpdated, eventPayload);
  logRealtimeEmit(SOCKET_EVENTS.prescriptionUpdated, null, eventPayload);
};

export const emitInventoryUpdated = (payload: {
  pharmacyId: number | string;
  medicineId?: number | string | null;
  orderId?: number | string | null;
  metadata?: Record<string, unknown>;
}) => {
  if (!socketServer) return;
  const eventPayload = {
    pharmacyId: Number(payload.pharmacyId),
    medicineId: payload.medicineId ?? null,
    orderId: payload.orderId ?? null,
    metadata: payload.metadata ?? {},
    updatedAt: new Date().toISOString(),
  };
  const room = pharmacyRoom(payload.pharmacyId);
  socketServer.to(room).emit(SOCKET_EVENTS.inventoryUpdated, eventPayload);
  logRealtimeEmit(SOCKET_EVENTS.inventoryUpdated, room, eventPayload);
};

export const emitQueueUpdated = (payload: Record<string, unknown>) => {
  if (!socketServer) return;
  const eventPayload = {
    ...payload,
    updatedAt: new Date().toISOString(),
  };
  socketServer.emit(SOCKET_EVENTS.queueUpdate, eventPayload);
  logRealtimeEmit(SOCKET_EVENTS.queueUpdate, null, eventPayload);
};

export const emitNotificationCreated = (payload: {
  userId: number | string;
  notification: Record<string, unknown>;
}) => {
  if (!socketServer) return;
  const eventPayload = {
    userId: Number(payload.userId),
    notification: payload.notification,
    createdAt: new Date().toISOString(),
  };
  const room = userRoom(payload.userId);
  socketServer.to(room).emit(SOCKET_EVENTS.notificationCreated, eventPayload);
  logRealtimeEmit(SOCKET_EVENTS.notificationCreated, room, eventPayload);
};
