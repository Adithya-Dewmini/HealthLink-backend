export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "preparing",
  "awaiting_substitution_approval",
  "partially_ready",
  "ready_for_pickup",
  "out_for_delivery",
  "delivered",
  "completed",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type FulfillmentType = "pickup" | "delivery";

export type DeliveryAddress = {
  line1: string;
  line2?: string | null;
  city?: string | null;
  district?: string | null;
  postalCode?: string | null;
  landmark?: string | null;
};

export type CheckoutInput = {
  fulfillmentType: FulfillmentType;
  notes?: string | null;
  deliveryAddress?: DeliveryAddress | null;
  deliveryNotes?: string | null;
  deliveryContactName?: string | null;
  deliveryContactPhone?: string | null;
};

export type UpdateOrderStatusInput = {
  id: number;
  status: OrderStatus;
};

export type OrderItemSummary = {
  id: number;
  marketplaceProductId: number;
  inventoryItemId: number;
  substitutedInventoryItemId: number | null;
  substitutionApproved: boolean;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  status: OrderStatus;
  imageUrl: string | null;
  requiresPrescription: boolean;
};

export type OrderSummary = {
  id: number;
  patientId: number;
  patientName: string | null;
  patientEmail: string | null;
  pharmacyId: number;
  prescriptionId: string | null;
  pharmacyName: string;
  status: OrderStatus;
  subtotal: number;
  discountTotal: number;
  total: number;
  fulfillmentType: FulfillmentType;
  notes: string | null;
  deliveryAddress: DeliveryAddress | null;
  deliveryNotes: string | null;
  deliveryContactName: string | null;
  deliveryContactPhone: string | null;
  deliveryStartedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItemSummary[];
};
