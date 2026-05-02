import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, createMockResponse } from "./helpers/http";

const { ioToMock, emitMock } = vi.hoisted(() => {
  const emit = vi.fn();
  return {
    ioToMock: vi.fn(() => ({ emit })),
    emitMock: emit,
  };
});

vi.mock("../src/config/env", () => ({
  env: {
    appWebUrl: "https://healthlink.app",
    publicAppUrl: "https://public.healthlink.app",
    receptionistSetupUrl: "https://healthlink.app/setup",
    mobileAppScheme: "healthlink",
  },
}));

vi.mock("../src/server", () => ({
  io: {
    to: ioToMock,
  },
}));

vi.mock("../src/services/receptionist.service", () => ({
  createReceptionistForMedicalCenter: vi.fn(),
  getReceptionistPermissions: vi.fn(),
  listReceptionistsByMedicalCenter: vi.fn(),
  removeReceptionistFromMedicalCenter: vi.fn(),
  resendReceptionistInvite: vi.fn(),
  updateReceptionistStatus: vi.fn(),
  updateReceptionistPermissions: vi.fn(),
}));

import {
  createReceptionist,
  resendReceptionistInviteController,
} from "../src/controllers/medicalCenterReceptionist.controller";
import {
  createReceptionistForMedicalCenter,
  resendReceptionistInvite,
} from "../src/services/receptionist.service";

describe("medical center receptionist controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a receptionist invite with configured links", async () => {
    vi.mocked(createReceptionistForMedicalCenter).mockResolvedValue({
      message: "Receptionist created successfully",
      receptionist: {
        id: 7,
        user_id: 70,
        name: "Saman Kumara",
        email: "saman@email.com",
      },
      setupLink: "healthlink://set-password?token=abc123",
      webLink: "https://healthlink.app/setup-password?token=abc123",
      expiresAt: "2026-04-22T00:00:00.000Z",
      emailSent: true,
      emailError: null,
    });

    const req = createMockRequest({
      medicalCenterId: "center-1",
      body: {
        name: "Saman Kumara",
        email: "saman@email.com",
        phone: "+94765554433",
      },
    });
    const res = createMockResponse();

    await createReceptionist(req as any, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(createReceptionistForMedicalCenter).toHaveBeenCalledWith({
      medicalCenterId: "center-1",
      name: "Saman Kumara",
      email: "saman@email.com",
      phone: "+94765554433",
      webBaseUrl: "https://healthlink.app",
      mobileScheme: "healthlink",
    });
    expect(ioToMock).toHaveBeenCalledWith("center_center-1");
    expect(emitMock).toHaveBeenCalled();
  });

  it("resends an invite for an existing receptionist", async () => {
    vi.mocked(resendReceptionistInvite).mockResolvedValue({
      message: "Setup invite resent successfully",
      receptionist: {
        id: 7,
        user_id: 70,
        name: "Saman Kumara",
        email: "saman@email.com",
      },
      setupLink: "healthlink://set-password?token=new-token",
      webLink: "https://healthlink.app/setup-password?token=new-token",
      expiresAt: "2026-04-22T00:00:00.000Z",
      emailSent: true,
      emailError: null,
    });

    const req = createMockRequest({
      medicalCenterId: "center-1",
      params: { id: "7" },
      body: {},
    });
    const res = createMockResponse();

    await resendReceptionistInviteController(req as any, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({
      message: "Setup invite resent successfully",
      receptionist: {
        id: 7,
        user_id: 70,
        name: "Saman Kumara",
        email: "saman@email.com",
      },
      setupLink: "healthlink://set-password?token=new-token",
      webLink: "https://healthlink.app/setup-password?token=new-token",
      expiresAt: "2026-04-22T00:00:00.000Z",
      emailSent: true,
      emailError: null,
    });
    expect(resendReceptionistInvite).toHaveBeenCalledWith({
      medicalCenterId: "center-1",
      receptionistId: "7",
      webBaseUrl: "https://healthlink.app",
      mobileScheme: "healthlink",
    });
  });
});
