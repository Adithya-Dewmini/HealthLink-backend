import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, createMockResponse } from "./helpers/http";

vi.mock("../src/services/auth.service", () => ({
  loginUserWithPassword: vi.fn(),
  setPasswordFromToken: vi.fn(),
}));

import { loginUser, setPassword } from "../src/controllers/auth.controller";
import { loginUserWithPassword, setPasswordFromToken } from "../src/services/auth.service";

describe("auth controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the authenticated user payload from login", async () => {
    vi.mocked(loginUserWithPassword).mockResolvedValue({
      token: "jwt-token",
      user: {
        id: 1,
        name: "Reception User",
        email: "reception@healthlink.lk",
        role: "receptionist",
        medical_center_id: "center-1",
        centers: [{ id: "center-1", role: "receptionist" }],
        is_password_set: true,
      },
    });

    const req = createMockRequest({
      body: {
        email: "reception@healthlink.lk",
        password: "StrongPass123",
        expoPushToken: "ExponentPushToken[test-token]",
      },
    });
    const res = createMockResponse();

    await loginUser(req as any, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({
      token: "jwt-token",
      user: {
        id: 1,
        name: "Reception User",
        email: "reception@healthlink.lk",
        role: "receptionist",
        medical_center_id: "center-1",
        centers: [{ id: "center-1", role: "receptionist" }],
        is_password_set: true,
      },
    });
    expect(loginUserWithPassword).toHaveBeenCalledWith({
      email: "reception@healthlink.lk",
      password: "StrongPass123",
      expoPushToken: "ExponentPushToken[test-token]",
    });
  });

  it("surfaces password setup validation errors", async () => {
    vi.mocked(setPasswordFromToken).mockRejectedValue(
      Object.assign(new Error("Invalid setup token"), { statusCode: 400 })
    );

    const req = createMockRequest({
      body: {
        token: "bad-token",
        password: "StrongPass123",
      },
    });
    const res = createMockResponse();

    await setPassword(req as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toEqual({
      message: "Invalid setup token",
    });
    expect(setPasswordFromToken).toHaveBeenCalledWith({
      token: "bad-token",
      password: "StrongPass123",
    });
  });
});
