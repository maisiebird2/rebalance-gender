// The mock query-builder below intentionally mimics supabase-js's fluent,
// dynamically-shaped chain (.select().eq().maybeSingle(), etc.) — typing
// that precisely isn't worth it for test plumbing, so `any` is allowed
// in this file only.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock everything actions.ts talks to ─────────────────────────────
// These are server/Next-only modules (cookies, redirect, cache) that
// don't run in a plain Vitest/Node environment, so we stub them out
// and drive the auth state / Supabase responses per-test below.

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({
  getSupabaseAdminClient: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  // Real Next.js `redirect()` throws to halt the request — mimic that
  // so requireAuth() actually stops execution in the "signed out" tests.
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { redirect } from "next/navigation";
import { addGenre, addPlatform, quickApprove, quickReject } from "./actions";

// ── Test helpers ─────────────────────────────────────────────────────

/**
 * Builds a fake Supabase query-builder chain. Every chainable method
 * (select/eq/order/limit/update) returns the same object, and the
 * object itself resolves to `result` whether you `await` it directly
 * (e.g. `.update().eq(...)`) or call a terminal method like
 * `.maybeSingle()`/`.insert()` first — matching how the real
 * supabase-js builder behaves.
 */
function chain(result: { data?: unknown; error?: unknown }) {
  const builder: any = {};
  for (const method of ["select", "eq", "order", "limit", "update"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.insert = vi.fn(() => Promise.resolve(result));
  builder.then = (onResolve: any, onReject: any) =>
    Promise.resolve(result).then(onResolve, onReject);
  return builder;
}

function mockAuthedUser() {
  (createClient as any).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u1" } } }) },
  });
}

function mockSignedOut() {
  (createClient as any).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
  });
}

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function mockAdminFrom(...chains: ReturnType<typeof chain>[]) {
  const fromMock = vi.fn();
  for (const c of chains) fromMock.mockReturnValueOnce(c);
  (getSupabaseAdminClient as any).mockReturnValue({ from: fromMock });
  return fromMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  (redirect as any).mockImplementation(() => {
    throw new Error("NEXT_REDIRECT");
  });
});

// ── addGenre ─────────────────────────────────────────────────────────

describe("addGenre", () => {
  it("redirects to login when signed out", async () => {
    mockSignedOut();
    await expect(addGenre(formData({ name: "techno" }))).rejects.toThrow("NEXT_REDIRECT");
  });

  it("rejects a blank name without touching the database", async () => {
    mockAuthedUser();
    const fromMock = mockAdminFrom();

    const result = await addGenre(formData({ name: "   " }));

    expect(result).toEqual({ error: "Genre name is required" });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("rejects a name that already exists", async () => {
    mockAuthedUser();
    mockAdminFrom(chain({ data: { id: 1 } }));

    const result = await addGenre(formData({ name: "techno" }));

    expect(result).toEqual({ error: '"techno" already exists' });
  });

  it("trims whitespace and inserts a new genre", async () => {
    mockAuthedUser();
    const insertChain = chain({ error: null });
    mockAdminFrom(chain({ data: null }), insertChain);

    const result = await addGenre(formData({ name: "  deep house  " }));

    expect(result).toEqual({ success: true });
    expect(insertChain.insert).toHaveBeenCalledWith({ name: "deep house" });
  });

  it("surfaces a database error instead of silently failing", async () => {
    mockAuthedUser();
    mockAdminFrom(chain({ data: null }), chain({ error: { message: "insert failed" } }));

    const result = await addGenre(formData({ name: "gabber" }));

    expect(result).toEqual({ error: "insert failed" });
  });
});

// ── addPlatform ───────────────────────────────────────────────────────

describe("addPlatform", () => {
  it("redirects to login when signed out", async () => {
    mockSignedOut();
    await expect(addPlatform(formData({ label: "Mixcloud" }))).rejects.toThrow("NEXT_REDIRECT");
  });

  it("rejects a blank label without touching the database", async () => {
    mockAuthedUser();
    const fromMock = mockAdminFrom();

    const result = await addPlatform(formData({ label: "" }));

    expect(result).toEqual({ error: "Category name is required" });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("rejects a label with no usable characters", async () => {
    mockAuthedUser();
    const fromMock = mockAdminFrom();

    const result = await addPlatform(formData({ label: "!!!" }));

    expect(result).toEqual({
      error: "Couldn't derive a key from that name — try adding a letter or number",
    });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("slugifies a multi-word label into a snake_case key", async () => {
    mockAuthedUser();
    const insertChain = chain({ error: null });
    mockAdminFrom(chain({ data: null }), chain({ data: { sort_order: 140 } }), insertChain);

    const result = await addPlatform(formData({ label: "NTS Radio" }));

    expect(result).toEqual({ success: true });
    expect(insertChain.insert).toHaveBeenCalledWith({
      key: "nts_radio",
      label: "NTS Radio",
      sort_order: 150,
    });
  });

  it("starts sort_order at 10 when no platforms exist yet", async () => {
    mockAuthedUser();
    const insertChain = chain({ error: null });
    mockAdminFrom(chain({ data: null }), chain({ data: null }), insertChain);

    await addPlatform(formData({ label: "Mixcloud" }));

    expect(insertChain.insert).toHaveBeenCalledWith({
      key: "mixcloud",
      label: "Mixcloud",
      sort_order: 10,
    });
  });

  it("rejects a label whose derived key already exists", async () => {
    mockAuthedUser();
    mockAdminFrom(chain({ data: { key: "soundcloud" } }));

    const result = await addPlatform(formData({ label: "SoundCloud" }));

    expect(result).toEqual({ error: '"SoundCloud" already exists' });
  });

  it("surfaces a database error instead of silently failing", async () => {
    mockAuthedUser();
    mockAdminFrom(
      chain({ data: null }),
      chain({ data: null }),
      chain({ error: { message: "insert failed" } })
    );

    const result = await addPlatform(formData({ label: "Tidal" }));

    expect(result).toEqual({ error: "insert failed" });
  });
});

// ── quickApprove / quickReject ───────────────────────────────────────
// (existing submission-review actions, re-tested here since they moved
// from admin/submissions/actions.ts into this file)

describe("quickApprove", () => {
  it("redirects to login when signed out", async () => {
    mockSignedOut();
    await expect(quickApprove("artist-1")).rejects.toThrow("NEXT_REDIRECT");
  });

  it("approves a pending submission", async () => {
    mockAuthedUser();
    const updateChain = chain({ error: null });
    mockAdminFrom(updateChain);

    const result = await quickApprove("artist-1");

    expect(result).toBeUndefined();
    expect(updateChain.update).toHaveBeenCalledWith({ status: "approved" });
    expect(updateChain.eq).toHaveBeenCalledWith("id", "artist-1");
  });

  it("surfaces a database error instead of silently failing", async () => {
    mockAuthedUser();
    mockAdminFrom(chain({ error: { message: "db down" } }));

    const result = await quickApprove("artist-1");

    expect(result).toEqual({ error: "db down" });
  });
});

describe("quickReject", () => {
  it("rejects a pending submission", async () => {
    mockAuthedUser();
    const updateChain = chain({ error: null });
    mockAdminFrom(updateChain);

    const result = await quickReject("artist-1");

    expect(result).toBeUndefined();
    expect(updateChain.update).toHaveBeenCalledWith({ status: "rejected" });
  });
});
