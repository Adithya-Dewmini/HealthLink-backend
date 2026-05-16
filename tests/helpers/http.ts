import type { Request, Response } from "express";
import { vi } from "vitest";

export const createMockRequest = <TBody = Record<string, unknown>>(
  overrides: Partial<Request> & { body?: TBody } = {}
) => overrides as Request;

export const createMockResponse = () => {
  const res: Partial<Response> & {
    statusCode: number;
    body?: unknown;
    headers: Record<string, unknown>;
  } = {
    statusCode: 200,
    headers: {},
  };

  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  });

  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res as Response;
  });

  res.setHeader = vi.fn((key: string, value: unknown) => {
    res.headers[key] = value;
  });

  res.set = vi.fn((headers: Record<string, unknown>) => {
    Object.assign(res.headers, headers);
    return res as Response;
  });

  res.end = vi.fn((payload?: unknown) => {
    res.body = payload;
    return res as Response;
  });

  res.send = vi.fn((payload?: unknown) => {
    res.body = payload;
    return res as Response;
  });

  return res as Response & {
    statusCode: number;
    body?: unknown;
    headers: Record<string, unknown>;
  };
};
