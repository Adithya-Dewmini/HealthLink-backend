const SPECIALTY_RULES = [
  {
    specialty: "Pediatrician",
    keywords: ["child fever", "baby cough", "child", "baby", "infant", "kids", "pediatric"],
    confidence: "high",
  },
  {
    specialty: "Dentist",
    keywords: ["dentist", "toothache", "tooth", "teeth", "gum", "dental"],
    confidence: "high",
  },
  {
    specialty: "Dermatologist",
    keywords: ["eczema", "skin", "rash", "acne", "allergy", "itching"],
    confidence: "high",
  },
  {
    specialty: "Eye Specialist",
    keywords: ["red eye", "eye pain", "eye", "vision", "blurry", "eyesight"],
    confidence: "high",
  },
  {
    specialty: "ENT Specialist",
    keywords: ["tonsil", "hearing", "ear", "nose", "throat", "sinus"],
    confidence: "high",
  },
  {
    specialty: "Cardiologist",
    keywords: ["cardiologist", "heart", "chest pain", "palpitation", "high blood pressure", "low blood pressure", "blood pressure"],
    confidence: "medium",
  },
  {
    specialty: "Gynecologist",
    keywords: ["pregnancy", "pregnant", "periods", "gynecology", "women health"],
    confidence: "high",
  },
  {
    specialty: "Orthopedic Doctor",
    keywords: ["fracture", "joint", "knee", "back pain", "shoulder pain", "bone"],
    confidence: "high",
  },
  {
    specialty: "Mental Health Specialist",
    keywords: ["anxiety", "stress", "depression", "panic", "mental"],
    confidence: "high",
  },
  {
    specialty: "Endocrinologist",
    keywords: ["diabetes", "sugar", "thyroid", "hormone"],
    confidence: "medium",
  },
  {
    specialty: "Urologist",
    keywords: ["urine", "kidney", "bladder"],
    confidence: "medium",
  },
  {
    specialty: "Gastroenterologist",
    keywords: ["gastroenterologist", "stomach", "gastric", "acid", "liver"],
    confidence: "medium",
  },
  {
    specialty: "Neurologist",
    keywords: ["neurologist", "migraine", "seizure", "nerve", "numbness"],
    confidence: "medium",
  },
  {
    specialty: "General Physician",
    keywords: [
      "general physician",
      "fever",
      "cough",
      "cold",
      "flu",
      "headache",
      "stomach pain",
      "vomiting",
      "diarrhea",
      "body pain",
      "tired",
      "weakness",
    ],
    confidence: "medium",
  },
] as const;

const contains = (message: string, keyword: string) => message.includes(keyword);

export const inferSpecialty = (message: string) => {
  const normalized = message.trim().toLowerCase();

  for (const rule of SPECIALTY_RULES) {
    const symptoms = rule.keywords.filter((keyword) => contains(normalized, keyword));
    if (symptoms.length > 0) {
      return {
        specialty: rule.specialty,
        symptoms,
        confidence: rule.confidence as "low" | "medium" | "high",
      };
    }
  }

  return {
    specialty: undefined,
    symptoms: [] as string[],
    confidence: "low" as const,
  };
};
