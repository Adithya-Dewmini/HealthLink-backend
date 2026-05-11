import { HttpError } from "../pharmacy/errors";
import type { RegisterPushTokenInput } from "./types";

const asTrimmedString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const parsePositiveInt = (value: unknown, label: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `Valid ${label} is required`);
  }
  return parsed;
};

export const validateRegisterPushTokenPayload = (body: any): RegisterPushTokenInput => {
  const expoPushToken = asTrimmedString(body?.expo_push_token ?? body?.expoPushToken);
  if (!expoPushToken) {
    throw new HttpError(400, "expo_push_token is required");
  }

  return {
    expoPushToken,
    devicePlatform: asTrimmedString(body?.device_platform ?? body?.devicePlatform) || null,
    deviceName: asTrimmedString(body?.device_name ?? body?.deviceName) || null,
    deviceModel: asTrimmedString(body?.device_model ?? body?.deviceModel) || null,
    appVersion: asTrimmedString(body?.app_version ?? body?.appVersion) || null,
  };
};

export const validateNotificationRouteId = (value: unknown) =>
  parsePositiveInt(value, "notification id");

export const validateNotificationQuery = (query: Record<string, unknown>) => {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
};
