const FILLER_WORDS = new Set([
  "do",
  "you",
  "have",
  "need",
  "want",
  "find",
  "search",
  "buy",
  "medicine",
  "medication",
  "medications",
  "tablets",
  "tablet",
  "capsule",
  "capsules",
  "syrup",
  "please",
  "for",
  "me",
  "get",
  "show",
  "any",
  "available",
  "availability",
  "a",
  "an",
  "the",
  "some",
  "my",
  "is",
  "are",
  "there",
  "can",
  "i",
  "we",
  "us",
  "with",
  "of",
  "to",
  "on",
  "at",
  "from",
  "right",
  "now",
  "doctor",
  "doctors",
  "cardiologist",
  "physician",
  "clinic",
  "clinics",
]);

const DOSAGE_FORMS = ["tablet", "tablets", "capsule", "capsules", "syrup", "drops", "cream", "ointment"] as const;

const PRODUCT_HINTS: Array<{ terms: string[]; category: string; reason: string }> = [
  { terms: ["fever", "temperature"], category: "fever care", reason: "fever" },
  { terms: ["cough", "cold"], category: "cough & cold", reason: "cough/cold" },
  { terms: ["wound", "cut"], category: "first aid", reason: "wound care" },
  { terms: ["diabetes", "sugar"], category: "diabetic care", reason: "diabetes support" },
  { terms: ["blood pressure", "bp"], category: "blood pressure monitor", reason: "blood pressure support" },
  { terms: ["baby", "child"], category: "baby care", reason: "baby care" },
  { terms: ["vitamin", "supplement"], category: "vitamins", reason: "supplements" },
  { terms: ["oral rehydration salts", "ors"], category: "oral rehydration salts", reason: "rehydration support" },
];

const DIRECT_QUERY_MAPPINGS: Array<{ terms: string[]; normalized: string }> = [
  { terms: ["panadol", "acetaminophen"], normalized: "paracetamol" },
  { terms: ["fever medicine", "medicine for fever", "fever meds"], normalized: "fever care" },
  { terms: ["ors"], normalized: "oral rehydration salts" },
  { terms: ["bp monitor"], normalized: "blood pressure monitor" },
];

const SYNONYM_GROUPS = [
  ["paracetamol", "panadol", "acetaminophen"],
  ["oral rehydration salts", "ors"],
  ["blood pressure monitor", "bp monitor"],
] as const;

const sanitizeQuery = (input: string) =>
  String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const containsWholeTerm = (message: string, term: string) =>
  new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(message);

const applyDirectMappings = (input: string) => {
  let mapped = input;
  for (const entry of DIRECT_QUERY_MAPPINGS) {
    for (const term of entry.terms) {
      const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "g");
      mapped = mapped.replace(pattern, entry.normalized);
    }
  }
  return mapped.replace(/\s+/g, " ").trim();
};

export const normalizeMedicineQuery = (input: string): string => {
  const sanitized = sanitizeQuery(input);
  if (!sanitized) {
    return "";
  }

  const mapped = applyDirectMappings(sanitized);
  const tokens = mapped
    .split(" ")
    .filter((token) => token && !FILLER_WORDS.has(token));

  const normalized = applyDirectMappings(tokens.join(" ").trim());
  return normalized.replace(/\s+/g, " ").trim();
};

export const expandMedicineSynonyms = (input?: string): string[] => {
  const normalized = normalizeMedicineQuery(input ?? "");
  if (!normalized) {
    return [];
  }

  const matches = SYNONYM_GROUPS.find((group) => group.some((term) => term === normalized));
  if (!matches) {
    return [normalized];
  }

  return Array.from(new Set([normalized, ...matches]));
};

export const extractMedicineName = (message: string): string | undefined => {
  const normalized = normalizeMedicineQuery(message);
  if (!normalized) {
    return undefined;
  }

  const categoryHint = inferPharmacyCategory(message);
  if (categoryHint && normalized === categoryHint.category) {
    return undefined;
  }

  return normalized || undefined;
};

export const extractDosageForm = (message: string): string | undefined =>
  DOSAGE_FORMS.find((term) => sanitizeQuery(message).includes(term));

export const inferPharmacyCategory = (message: string) => {
  const normalized = sanitizeQuery(message);
  return PRODUCT_HINTS.find((hint) => hint.terms.some((term) => containsWholeTerm(normalized, term)));
};

export const buildPharmacySearchCandidates = (input: {
  query?: string;
  medicineName?: string;
  category?: string;
  symptom?: string;
}) => {
  const candidates = new Set<string>();
  const normalizedQuery = normalizeMedicineQuery(input.query ?? "");
  const normalizedMedicineName = normalizeMedicineQuery(input.medicineName ?? "");
  const normalizedCategory = sanitizeQuery(input.category ?? "");
  const normalizedSymptom = sanitizeQuery(input.symptom ?? "");
  const symptomCategory = inferPharmacyCategory(normalizedSymptom)?.category;

  const push = (value?: string) => {
    const normalized = normalizeMedicineQuery(value ?? "");
    if (normalized) {
      candidates.add(normalized);
    }
  };

  push(normalizedQuery);
  push(normalizedMedicineName);

  for (const synonym of expandMedicineSynonyms(normalizedQuery || normalizedMedicineName)) {
    push(synonym);
  }

  if (normalizedCategory) {
    candidates.add(normalizedCategory);
  }
  if (symptomCategory) {
    candidates.add(symptomCategory);
  }
  if (normalizedSymptom) {
    candidates.add(normalizedSymptom);
  }
  if (sanitizeQuery(input.query ?? "")) {
    candidates.add(sanitizeQuery(input.query ?? ""));
  }

  return Array.from(candidates);
};
