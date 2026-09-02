// The mock query-builder below intentionally mimics supabase-js's fluent,
// dynamically-shaped chain (.update().eq(), .select().eq().maybeSingle()),
// so `any` is allowed in this file only.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Server/Next-only modules that don't run under plain Vitest: the request
// cookie jar behind getViewer(), the service-role client, and the cache
// helpers whose calls these tests are actually about.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({
  getSupabaseAdminClient: vi.fn(),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { revalidateTag } from "next/cache";
import { approveOrganisations, setOrganisationStatus } from "./actions";

function chain(result: { data?: unknown; error?: unknown }) {
  const builder: any = {};
  for (const method of ["select", "eq", "in", "is", "order", "limit", "update", "delete"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.single = vi.fn(() => Promise.resolve(result));
  builder.insert = vi.fn(() => builder);
  builder.upsert = vi.fn(() => Promise.resolve(result));
  builder.then = (onResolve: any, onReject: any) =>
    Promise.resolve(result).then(onResolve, onReject);
  return builder;
}

function mockAdminFrom(...chains: ReturnType<typeof chain>[]) {
  const fromMock = vi.fn();
  for (const c of chains) fromMock.mockReturnValueOnce(c);
  fromMock.mockReturnValue(chain({ data: [], error: null }));
  (getSupabaseAdminClient as any).mockReturnValue({ from: fromMock });
  return fromMock;
}

function mockAuthedAdmin() {
  (createClient as any).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: {
          user: { id: "u1", email: "admin@example.com", app_metadata: { role: "admin" } },
        },
      }),
    },
  });
}

function mockSignedOut() {
  (createClient as any).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Admin status must come from app_metadata here, not the env fallback.
  vi.stubEnv("ADMIN_EMAILS", "");
});

// The regression these cover: the approved-organisation list feeding the
// artist / submit / revise pickers is cached under the "organisations" tag
// (getOrganisationPickerOptions in src/lib/queries.ts). The tag was declared
// but never busted, so a newly approved organisation stayed missing from the
// type-ahead until the cache's own 600-second window lapsed. revalidatePath()
// on the admin routes does not reach a tagged cache entry.
describe("organisation moderation busts the picker cache", () => {
  it("revalidates the organisations tag when the pending queue is approved", async () => {
    mockAuthedAdmin();
    mockAdminFrom(chain({ error: null }));

    const result = await approveOrganisations(["org-1", "org-2"]);

    expect(result).toEqual({ success: true, count: 2 });
    expect(revalidateTag).toHaveBeenCalledWith("organisations", "max");
  });

  it("revalidates the organisations tag when one organisation's status changes", async () => {
    mockAuthedAdmin();
    mockAdminFrom(chain({ error: null }));

    const result = await setOrganisationStatus("org-1", "approved");

    expect(result).toEqual({ success: true });
    expect(revalidateTag).toHaveBeenCalledWith("organisations", "max");
  });

  it("does not revalidate when the caller isn't signed in", async () => {
    mockSignedOut();
    mockAdminFrom(chain({ error: null }));

    const result = await setOrganisationStatus("org-1", "approved");

    expect(result).toEqual({ error: "Not authenticated" });
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
