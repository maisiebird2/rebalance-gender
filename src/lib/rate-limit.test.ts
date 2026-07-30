import { describe, it, expect } from "vitest";
import { checkRateLimit, getClientIp } from "./rate-limit";

// Each test uses its own key so tests don't share buckets (module state).
let n = 0;
function freshKey(): string {
  return `test-key-${n++}`;
}

describe("checkRateLimit", () => {
  it("allows calls up to the limit inside one window", () => {
    const key = freshKey();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(key, 3, 60_000, t0 + i).allowed).toBe(true);
    }
  });

  it("rejects the call after the limit with a retry hint", () => {
    const key = freshKey();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) checkRateLimit(key, 3, 60_000, t0);

    const result = checkRateLimit(key, 3, 60_000, t0 + 30_000);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(30);
  });

  it("reports at least 1 second even at the window edge", () => {
    const key = freshKey();
    const t0 = 1_000_000;
    for (let i = 0; i < 2; i++) checkRateLimit(key, 1, 60_000, t0);
    const result = checkRateLimit(key, 1, 60_000, t0 + 59_900);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(1);
  });

  it("opens a fresh window once the previous one expires", () => {
    const key = freshKey();
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) checkRateLimit(key, 3, 60_000, t0);
    expect(checkRateLimit(key, 3, 60_000, t0).allowed).toBe(false);

    expect(checkRateLimit(key, 3, 60_000, t0 + 60_000).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const a = freshKey();
    const b = freshKey();
    const t0 = 1_000_000;
    for (let i = 0; i < 2; i++) checkRateLimit(a, 1, 60_000, t0);
    expect(checkRateLimit(a, 1, 60_000, t0).allowed).toBe(false);
    expect(checkRateLimit(b, 1, 60_000, t0).allowed).toBe(true);
  });
});

describe("getClientIp", () => {
  it("takes the first x-forwarded-for entry", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    expect(getClientIp({ headers })).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip", () => {
    const headers = new Headers({ "x-real-ip": "203.0.113.7" });
    expect(getClientIp({ headers })).toBe("203.0.113.7");
  });

  it("falls back to a shared key when no header is present", () => {
    expect(getClientIp({ headers: new Headers() })).toBe("unknown");
  });
});
