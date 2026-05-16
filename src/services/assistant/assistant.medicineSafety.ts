export type MedicineSafetyLevel =
  | "GENERAL_PRODUCT"
  | "OTC_CAUTION"
  | "PRESCRIPTION_REQUIRED"
  | "CONTROLLED_OR_UNSUPPORTED"
  | "UNKNOWN";

const CONTROLLED_TERMS = [
  "morphine",
  "tramadol",
  "codeine",
  "narcotic",
  "sedative",
  "controlled substance",
  "sleeping tablet",
  "sleeping tablets",
];

const PRESCRIPTION_TERMS = [
  "antibiotic",
  "antibiotics",
  "amoxicillin",
  "azithromycin",
  "ciprofloxacin",
  "insulin",
  "blood pressure medicine",
  "bp medicine",
  "diabetes medicine",
  "steroid tablet",
  "steroid tablets",
  "antidepressant",
  "antidepressants",
  "strong painkiller",
  "strong painkillers",
];

const GENERAL_PRODUCT_TERMS = [
  "thermometer",
  "mask",
  "masks",
  "sanitizer",
  "bandage",
  "ors",
  "glucose meter",
  "bp monitor",
  "blood pressure monitor",
  "test strip",
  "test strips",
];

const OTC_CAUTION_TERMS = [
  "paracetamol",
  "panadol",
  "acetaminophen",
  "cough syrup",
  "antihistamine",
  "antacid",
  "vitamin",
  "vitamins",
  "supplement",
  "supplements",
];

const containsAny = (value: string, terms: string[]) => terms.some((term) => value.includes(term));

export const classifyMedicineSafety = (message: string, medicineName?: string) => {
  const normalized = `${message} ${medicineName ?? ""}`.trim().toLowerCase();

  if (containsAny(normalized, CONTROLLED_TERMS)) {
    return {
      level: "CONTROLLED_OR_UNSUPPORTED" as const,
      requiresPrescription: true,
      warning: "I can’t help with ordering controlled or restricted medicines through chat.",
    };
  }

  if (containsAny(normalized, PRESCRIPTION_TERMS)) {
    return {
      level: "PRESCRIPTION_REQUIRED" as const,
      requiresPrescription: true,
      warning:
        "This medicine may require a valid prescription or pharmacist/doctor review.",
    };
  }

  if (containsAny(normalized, GENERAL_PRODUCT_TERMS)) {
    return {
      level: "GENERAL_PRODUCT" as const,
      requiresPrescription: false,
      warning:
        "Please follow label instructions and consult a pharmacist or doctor if you are unsure.",
    };
  }

  if (containsAny(normalized, OTC_CAUTION_TERMS)) {
    return {
      level: "OTC_CAUTION" as const,
      requiresPrescription: false,
      warning:
        "Please follow label instructions and consult a pharmacist or doctor if symptoms continue.",
    };
  }

  return {
    level: "UNKNOWN" as const,
    requiresPrescription: false,
    warning:
      "Please follow label instructions and consult a pharmacist or doctor if you are unsure.",
  };
};
