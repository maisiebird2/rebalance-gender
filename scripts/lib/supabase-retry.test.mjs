import { describe, it, expect, vi } from "vitest";
import { isNetworkFailure, runWithNetworkRetry } from "./supabase-retry.mjs";

// The shape postgrest-js returns when fetch itself rejected: the
// TypeError is caught and wrapped into `error`, with response status 0.
const wrappedNetworkFailure = {
  data: null,
  error: { message: "TypeError: fetch failed", details: "TypeError: fetch failed\n    at ...", code: "" },
  count: null,
  status: 0,
  statusText: "",
};

const ok = { data: [{ artist_id: "a1" }], error: null, status: 200 };
const httpError = { data: null, error: { message: "permission denied for table artists", code: "42501" }, status: 403 };

const noSleep = () => Promise.resolve();

describe("isNetworkFailure", () => {
  it("recognizes the postgrest fetch-rejection wrapping via status 0", () => {
    expect(isNetworkFailure(wrappedNetworkFailure)).toBe(true);
  });

  it("recognizes connectivity-looking messages even without status 0", () => {
    expect(isNetworkFailure({ error: { message: "TypeError: fetch failed" } })).toBe(true);
    expect(isNetworkFailure({ error: { message: "connect ECONNRESET 1.2.3.4:443" } })).toBe(true);
  });

  it("treats HTTP-level errors and successes as non-network", () => {
    expect(isNetworkFailure(httpError)).toBe(false);
    expect(isNetworkFailure(ok)).toBe(false);
  });

  it("classifies thrown errors, including via their cause", () => {
    expect(isNetworkFailure(null, new TypeError("fetch failed"))).toBe(true);
    const withCause = new TypeError("fetch failed");
    withCause.cause = new Error("getaddrinfo ENOTFOUND db.example.supabase.co");
    expect(isNetworkFailure(null, withCause)).toBe(true);
    expect(isNetworkFailure(null, new Error("column does not exist"))).toBe(false);
  });
});

describe("runWithNetworkRetry", () => {
  it("returns a success immediately without retrying", async () => {
    const run = vi.fn().mockResolvedValue(ok);
    const res = await runWithNetworkRetry(run, { sleepFn: noSleep });
    expect(res).toBe(ok);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns an HTTP-level error on the first attempt (no retry)", async () => {
    const run = vi.fn().mockResolvedValue(httpError);
    const res = await runWithNetworkRetry(run, { sleepFn: noSleep });
    expect(res).toBe(httpError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries a network failure and returns the eventual success", async () => {
    const run = vi.fn().mockResolvedValueOnce(wrappedNetworkFailure).mockResolvedValueOnce(ok);
    const res = await runWithNetworkRetry(run, { sleepFn: noSleep });
    expect(res).toBe(ok);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("gives up after the delays run out and returns the failing response", async () => {
    const run = vi.fn().mockResolvedValue(wrappedNetworkFailure);
    const res = await runWithNetworkRetry(run, { delaysMs: [0, 0], sleepFn: noSleep });
    expect(res).toBe(wrappedNetworkFailure);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("retries a network-shaped rejection and rethrows it once attempts run out", async () => {
    const err = new TypeError("fetch failed");
    const run = vi.fn().mockRejectedValue(err);
    await expect(runWithNetworkRetry(run, { delaysMs: [0], sleepFn: noSleep })).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-network rejection immediately", async () => {
    const err = new Error("boom: undefined is not a function");
    const run = vi.fn().mockRejectedValue(err);
    await expect(runWithNetworkRetry(run, { sleepFn: noSleep })).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("waits the configured backoff between attempts", async () => {
    const sleeps = [];
    const sleepFn = (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const run = vi.fn().mockResolvedValue(wrappedNetworkFailure);
    await runWithNetworkRetry(run, { delaysMs: [1000, 4000], sleepFn });
    expect(sleeps).toEqual([1000, 4000]);
  });
});
