import { HttpError } from "../pharmacy/errors";

type PaymentGuardOrder = {
  payment_method?: string | null;
  payment_status?: string | null;
};

export const assertOrderReadyForPharmacyProcessing = (order: PaymentGuardOrder) => {
  const paymentMethod = String(order.payment_method || "").toLowerCase();
  const paymentStatus = String(order.payment_status || "").toLowerCase();

  if (paymentMethod === "online" && paymentStatus !== "paid") {
    throw new HttpError(409, "Online payment is still pending for this order");
  }
};
