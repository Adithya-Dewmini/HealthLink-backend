import { HttpError } from "../pharmacy/errors";

const parsePositiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

export const validateActivityQuery = (query: Record<string, unknown>) => {
  const page = parsePositiveInt(query.page, 1);
  const requestedLimit = parsePositiveInt(query.limit, 20);
  const limit = Math.min(requestedLimit, 50);
  const offset = (page - 1) * limit;

  return { page, limit, offset };
};

export const validateOrderTimelineId = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, "Valid order id is required");
  }
  return parsed;
};
