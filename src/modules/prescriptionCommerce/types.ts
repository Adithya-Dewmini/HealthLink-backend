export type PrescriptionCartMatchItem = {
  prescriptionItemId: number;
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
  prescriptionItemId: number;
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
  notes?: string | null;
};
