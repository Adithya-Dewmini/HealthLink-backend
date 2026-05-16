import { describe, expect, it } from "vitest";
import { validateCreatePrescriptionOrderPayload } from "../src/modules/prescriptionCommerce/validation";

describe("prescription commerce validation", () => {
  it("accepts delivery details for prescription orders", () => {
    const payload = validateCreatePrescriptionOrderPayload({
      pharmacy_id: 12,
      accept_partial: true,
      fulfillment_method: "delivery",
      notes: "Leave at reception",
      delivery_address: {
        line1: "22 Palm Grove",
        city: "Colombo",
        district: "Colombo",
      },
      delivery_notes: "Ring the bell",
      delivery_contact_name: "Jane Doe",
      delivery_contact_phone: "0771234567",
    });

    expect(payload).toEqual({
      pharmacyId: 12,
      acceptPartial: true,
      fulfillmentMethod: "delivery",
      paymentMethod: null,
      notes: "Leave at reception",
      deliveryAddress: {
        line1: "22 Palm Grove",
        line2: null,
        city: "Colombo",
        district: "Colombo",
        postalCode: null,
        landmark: null,
      },
      deliveryNotes: "Ring the bell",
      deliveryContactName: "Jane Doe",
      deliveryContactPhone: "0771234567",
    });
  });

  it("rejects delivery orders without a contact phone", () => {
    expect(() =>
      validateCreatePrescriptionOrderPayload({
        pharmacy_id: 12,
        fulfillment_method: "delivery",
        delivery_address: { line1: "22 Palm Grove" },
        delivery_contact_name: "Jane Doe",
      })
    ).toThrow("delivery_contact_phone is required for delivery orders");
  });
});
