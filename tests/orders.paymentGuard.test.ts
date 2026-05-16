import { describe, expect, it } from "vitest";
import { assertOrderReadyForPharmacyProcessing } from "../src/modules/orders/paymentGuard";

describe("order payment guard", () => {
  it("blocks pharmacist processing for unpaid online orders", () => {
    expect(() =>
      assertOrderReadyForPharmacyProcessing({
        payment_method: "online",
        payment_status: "pending",
      })
    ).toThrowError("Online payment is still pending for this order");
  });

  it("allows pharmacist processing for paid online orders", () => {
    expect(() =>
      assertOrderReadyForPharmacyProcessing({
        payment_method: "online",
        payment_status: "paid",
      })
    ).not.toThrow();
  });
});
