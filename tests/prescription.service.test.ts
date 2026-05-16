import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("../src/config/db", () => ({
  default: {
    query: queryMock,
  },
}));

vi.mock("../src/config/env", () => ({
  env: {
    jwtSecret: "test-jwt-secret",
  },
}));

import {
  createPrescriptionQrToken,
  ensurePrescriptionQrToken,
  verifyPrescriptionToken,
} from "../src/services/prescription.service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prescription QR service", () => {
  it("verifies the active QR token against the stored prescription consultation context", async () => {
    const token = createPrescriptionQrToken({
      prescriptionId: 15,
      consultationId: 48,
      patientId: 9,
      doctorId: 21,
      medicalCenterId: "clinic-1",
    });

    queryMock.mockResolvedValue({
      rows: [
        {
          prescription_id: 15,
          consultation_id: 48,
          patient_id: 9,
          doctor_id: 21,
          medical_center_id: "clinic-1",
          qr_code: token,
          dispensed_at: null,
        },
      ],
    });

    await expect(verifyPrescriptionToken(token)).resolves.toMatchObject({
      prescriptionId: 15,
      consultationId: 48,
      patientId: 9,
      doctorId: 21,
      medicalCenterId: "clinic-1",
      dispensedAt: null,
    });
  });

  it("rejects a token when it is not the active stored QR for the prescription", async () => {
    const token = createPrescriptionQrToken({
      prescriptionId: 15,
      consultationId: 48,
      patientId: 9,
      doctorId: 21,
      medicalCenterId: "clinic-1",
    });

    queryMock.mockResolvedValue({
      rows: [
        {
          prescription_id: 15,
          consultation_id: 48,
          patient_id: 9,
          doctor_id: 21,
          medical_center_id: "clinic-1",
          qr_code: "different-token",
          dispensed_at: null,
        },
      ],
    });

    await expect(verifyPrescriptionToken(token)).rejects.toMatchObject({
      message: "Prescription QR is no longer active",
      statusCode: 401,
    });
  });

  it("refreshes an incomplete legacy token so the QR binds to consultation, doctor, patient, and clinic", async () => {
    const legacyToken = createPrescriptionQrToken({
      prescriptionId: 15,
      patientId: 9,
    });

    queryMock.mockResolvedValue({ rows: [] });

    const result = await ensurePrescriptionQrToken(
      { query: queryMock as any },
      {
        prescriptionId: 15,
        consultationId: 48,
        patientId: 9,
        doctorId: 21,
        medicalCenterId: "clinic-1",
        qrCode: legacyToken,
        isDispensed: false,
      }
    );

    expect(result.refreshed).toBe(true);
    expect(result.qrToken).not.toBe(legacyToken);
    expect(queryMock).toHaveBeenCalledWith(
      "UPDATE prescriptions SET qr_code = $1 WHERE id = $2",
      [result.qrToken, 15]
    );
  });
});
