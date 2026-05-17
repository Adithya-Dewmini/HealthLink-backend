export const ORDER_STATUSES = [
  "pending_payment",
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
  "rejected",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderItemStatus =
  | OrderStatus
  | "available"
  | "partial"
  | "unavailable"
  | "substituted"
  | "fulfilled";

export type FulfillmentType = "pickup" | "delivery";
export type PaymentGateway = "payhere";
export type PaymentMethod = "cash" | "online";
export type PaymentStatus = "pending" | "paid" | "failed" | "cancelled" | "refunded";

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
  paymentMethod?: PaymentMethod | null;
  notes?: string | null;
  deliveryAddress?: DeliveryAddress | null;
  deliveryNotes?: string | null;
  deliveryContactName?: string | null;
  deliveryContactPhone?: string | null;
};

export type PaymentSummary = {
  id: number;
  gateway: PaymentGateway;
  gatewayPaymentId: string | null;
  gatewayOrderId: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  method: string | null;
  cardNoMasked: string | null;
  statusMessage: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceSummary = {
  id: number;
  invoiceNo: string;
  amount?: number;
  status?: string;
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  discount: number;
  total: number;
  currency: string;
  pdfUrl: string | null;
  issuedAt: string;
  emailedAt?: string | null;
  emailTo?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpdateOrderStatusInput = {
  id: number;
  status: OrderStatus;
  note?: string | null;
};

export type ReviewOrderItemInput = {
  orderItemId: number;
  inventoryItemId?: number | null;
  approvedQuantity: number;
  itemStatus: "available" | "partial" | "unavailable" | "substituted";
  substitutionName?: string | null;
  note?: string | null;
};

export type ReviewOrderInput = {
  id: number;
  items: ReviewOrderItemInput[];
  pharmacistNote?: string | null;
};

export type RejectOrderInput = {
  id: number;
  reason: string;
};

export type OrderItemSummary = {
  id: number;
  marketplaceProductId: number;
  inventoryItemId: number;
  substitutedInventoryItemId: number | null;
  substitutionApproved: boolean;
  name: string;
  quantity: number;
  requestedQuantity: number;
  approvedQuantity: number;
  unitPrice: number;
  totalPrice: number;
  status: OrderItemStatus;
  prescriptionItemId: string | null;
  substitutionName: string | null;
  note: string | null;
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
  currency: string;
  fulfillmentType: FulfillmentType;
  paymentMethod: PaymentMethod | null;
  paymentStatus: PaymentStatus | null;
  paidAt: string | null;
  notes: string | null;
  pharmacistNote: string | null;
  rejectionReason: string | null;
  deliveryAddress: DeliveryAddress | null;
  deliveryNotes: string | null;
  deliveryContactName: string | null;
  deliveryContactPhone: string | null;
  deliveryStartedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
  payment: PaymentSummary | null;
  invoice: InvoiceSummary | null;
  items: OrderItemSummary[];
};
