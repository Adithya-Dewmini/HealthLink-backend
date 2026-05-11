import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import { sanitizeInput } from "../src/middleware/sanitizeInput";

describe("sanitizeInput middleware", () => {
  it("sanitizes getter-backed req.query without reassigning the property", () => {
    const query = {
      latest: " true ",
      "$where": "malicious",
      nested: {
        "safe": " ok ",
        "bad.key": "remove",
      },
    };

    const req = {
      body: {
        note: " hello ",
        "$gt": "remove",
      },
    } as Partial<Request>;

    Object.defineProperty(req, "query", {
      configurable: true,
      enumerable: true,
      get: () => query,
    });

    const next = vi.fn();

    expect(() => sanitizeInput(req as Request, {} as any, next)).not.toThrow();

    expect(req.body).toEqual({
      note: "hello",
    });
    expect(query).toEqual({
      latest: "true",
      nested: {
        safe: "ok",
      },
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
