import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, createMockResponse } from "./helpers/http";

vi.mock("../src/services/notification.service", () => ({
  listNotificationsForUser: vi.fn(),
  markNotificationRead: vi.fn(),
  registerPushToken: vi.fn().mockResolvedValue({ id: 88 }),
}));
vi.mock("../src/services/audit.service", () => ({
  createAuditLog: vi.fn(),
  getAuditRequestContext: vi.fn(() => ({
    actorUserId: 4,
    actorRole: "patient",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  })),
}));

import { registerPushTokenController } from "../src/modules/notifications/controller";
import { createAuditLog } from "../src/services/audit.service";

describe("notifications controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("audits push token registration", async () => {
    const req = createMockRequest({
      body: {
        expo_push_token: "ExponentPushToken[test]",
        device_platform: "ios",
        device_model: "iPhone",
      },
      user: { id: 4, role: "patient" },
    });
    const res = createMockResponse();

    await registerPushTokenController(req as any, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notification_token_registered",
        entityType: "push_token",
        entityId: 88,
      })
    );
  });
});
