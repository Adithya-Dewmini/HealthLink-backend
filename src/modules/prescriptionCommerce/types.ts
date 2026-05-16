import type { DeliveryAddress } from "../orders/types";

export type PrescriptionCartMatchItem = {
  prescriptionItemId: string;
  inventoryItemId: number;
  marketplaceProductId: number;
  medicineName: string;
  requiredQuantity: number;
  availableQuantity: number;
  missingQuantity: number;
  unitPrice: number;
  totalPrice: number;
  requiresPrescription: boolean;
};

export type PrescriptionCartMissingItem = {
  prescriptionItemId: string;
  medicineName: string;
  requiredQuantity: number;
  availableQuantity: number;
  missingQuantity: number;
};

export type PrescriptionPharmacyMatch = {
  pharmacy: {
    id: number;
    name: string;
    location: string | null;
  };
  coveragePercentage: number;
  availableItems: PrescriptionCartMatchItem[];
  missingItems: PrescriptionCartMissingItem[];
  estimatedTotal: number;
  fullyAvailable: boolean;
};

export type PrescriptionBuildCartResponse = {
  prescriptionId: string;
  matches: PrescriptionPharmacyMatch[];
};

export type CreatePrescriptionOrderInput = {
  pharmacyId: number;
  acceptPartial: boolean;
  fulfillmentMethod?: "pickup" | "delivery";
  paymentMethod?: "cash" | "online" | null;
  notes?: string | null;
  deliveryAddress?: DeliveryAddress | null;
  deliveryNotes?: string | null;
  deliveryContactName?: string | null;
  deliveryContactPhone?: string | null;
};
