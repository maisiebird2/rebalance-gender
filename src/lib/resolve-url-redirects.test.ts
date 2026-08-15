import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isResolvableHost,
  hostTier,
  hostExpectation,
  resolveRedirect,
  NOT_RESOLVED_HOSTS,
} from "./resolve-url-redirects";

// ------------------------------------------------------------
// Fake responses. resolveRedirect only ever touches status, the Location
// header, and body.cancel(), so that's all these need to carry.
// ------------------------------------------------------------
function redirectTo(location: string | null, status = 302) {
  return {
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "location" ? location : null) },
    body: null,
  } as unknown as Response;
}

function destination(status = 200) {
  return {
    status,
    headers: { get: () => null },
    body: null,
  } as unknown as Response;
}

/** Mocks a fetch chain: each entry is the response for the next request made. */
function mockChain(...responses: Response[]) {
  const spy = vi.spyOn(global, "fetch");
  for (const r of responses) spy.mockResolvedValueOnce(r);
  return spy;
}

describe("isResolvableHost", () => {
  it("is true for tier A share hosts", () => {
    expect(isResolvableHost("https://on.soundcloud.com/8KP9u6WaRSeo1ycHww")).toBe(true);
    expect(isResolvableHost("https://soundcloud.app.goo.gl/N1oiE")).toBe(true);
    expect(isResolvableHost("https://spotify.link/eqRHE9U72Db")).toBe(true);
    expect(isResolvableHost("https://vm.tiktok.com/ZSKeHLQN")).toBe(true);
    expect(isResolvableHost("https://fb.me/someartist")).toBe(true);
  });

  it("is true for tier B generic shorteners", () => {
    expect(isResolvableHost("https://bit.ly/abc123")).toBe(true);
    expect(isResolvableHost("https://goo.gl/ugfBAL")).toBe(true);
    expect(isResolvableHost("https://tinyurl.com/y8x9wqzp")).toBe(true);
  });

  it("is false for ordinary platform URLs", () => {
    expect(isResolvableHost("https://soundcloud.com/some-dj-name")).toBe(false);
    expect(isResolvableHost("https://www.instagram.com/techno_blondy")).toBe(false);
  });

  it("is false for every tier C host", () => {
    // These appear in the data in volume and are excluded on purpose — see
    // NOT_RESOLVED_HOSTS. If one of them ever becomes resolvable, that's a
    // deliberate decision, and this test is where it gets noticed.
    for (const host of NOT_RESOLVED_HOSTS.keys()) {
      expect(isResolvableHost(`https://${host}/something`)).toBe(false);
    }
  });

  it("matches hosts exactly, so goo.gl siblings stay distinct", () => {
    // The whole reason matching is exact: these three share a suffix but mean
    // completely different things.
    expect(isResolvableHost("https://soundcloud.app.goo.gl/N1oiE")).toBe(true);
    expect(isResolvableHost("https://goo.gl/ugfBAL")).toBe(true);
    expect(isResolvableHost("https://maps.app.goo.gl/abc")).toBe(false);
  });

  it("ignores www. and a missing scheme", () => {
    expect(isResolvableHost("https://www.bit.ly/abc")).toBe(true);
    expect(isResolvableHost("bit.ly/abc")).toBe(true);
    expect(isResolvableHost("  https://bit.ly/abc  ")).toBe(true);
  });

  it("is false for unparseable input rather than throwing", () => {
    expect(isResolvableHost("")).toBe(false);
    expect(isResolvableHost("not a url at all")).toBe(false);
    expect(isResolvableHost("http://")).toBe(false);
  });
});

describe("hostTier / hostExpectation", () => {
  it("reports the tier", () => {
    expect(hostTier("https://on.soundcloud.com/abc")).toBe("validate");
    expect(hostTier("https://bit.ly/abc")).toBe("reclassify");
    expect(hostTier("https://soundcloud.com/dj")).toBeNull();
  });

  it("reports a tier A expectation and nothing for tier B", () => {
    expect(hostExpectation("https://on.soundcloud.com/abc")).toBe("soundcloud.com");
    expect(hostExpectation("https://vm.tiktok.com/abc")).toBe("tiktok.com/@handle");
    expect(hostExpectation("https://bit.ly/abc")).toBeNull();
  });
});

describe("resolveRedirect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes no network call for a non-resolvable host", async () => {
    const spy = vi.spyOn(global, "fetch");
    const out = await resolveRedirect("https://soundcloud.com/some-dj-name");
    expect(spy).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      url: "https://soundcloud.com/some-dj-name",
      resolved: false,
      tier: null,
      reason: "not-resolvable",
    });
  });

  it("follows a single redirect", async () => {
    mockChain(redirectTo("https://www.youtube.com/channel/UC_dO"), destination(200));
    const out = await resolveRedirect("https://goo.gl/ugfBAL");
    expect(out).toMatchObject({
      url: "https://www.youtube.com/channel/UC_dO",
      resolved: true,
      tier: "reclassify",
      finalStatus: 200,
    });
    expect(out.reason).toBeUndefined();
  });

  it("follows a chain of redirects", async () => {
    mockChain(
      redirectTo("https://bit.ly/second"),
      redirectTo("https://soundcloud.com/final-artist"),
      destination(200)
    );
    const out = await resolveRedirect("https://bit.ly/first");
    expect(out.url).toBe("https://soundcloud.com/final-artist");
    expect(out.resolved).toBe(true);
  });

  it("resolves a Location header given as a relative path", async () => {
    mockChain(redirectTo("/real-artist"), destination(200));
    const out = await resolveRedirect("https://bit.ly/abc");
    expect(out.url).toBe("https://bit.ly/real-artist");
  });

  it("gives up after maxHops and keeps the original", async () => {
    mockChain(
      redirectTo("https://bit.ly/2"),
      redirectTo("https://bit.ly/3"),
      redirectTo("https://bit.ly/4")
    );
    const out = await resolveRedirect("https://bit.ly/1", { maxHops: 3 });
    expect(out.url).toBe("https://bit.ly/1");
    expect(out.resolved).toBe(false);
    expect(out.reason).toBe("max-hops");
  });

  it("treats a self-redirect as a loop, not as 'no redirect'", async () => {
    mockChain(redirectTo("https://bit.ly/abc"));
    const out = await resolveRedirect("https://bit.ly/abc");
    expect(out.reason).toBe("max-hops");
    expect(out.url).toBe("https://bit.ly/abc");
  });

  it("reports no-redirect when the host answers 200 at its own URL", async () => {
    // The smart-link shape (lnk.to, ffm.to). Those hosts are tier C so they
    // never get here, but a tier B host can behave the same way.
    mockChain(destination(200));
    const out = await resolveRedirect("https://bit.ly/abc");
    expect(out).toMatchObject({ url: "https://bit.ly/abc", resolved: false, reason: "no-redirect" });
  });

  it("refuses a destination that resolved but is dead", async () => {
    // The real case: soundcloud.app.goo.gl/Hqa78gdDiUTcPHxc7 resolves cleanly
    // to soundcloud.com/ahuraaghabeigi, which 404s. Overwriting a live row
    // with a known-dead URL is worse than leaving it alone.
    mockChain(redirectTo("https://soundcloud.com/ahuraaghabeigi"), destination(404));
    const out = await resolveRedirect("https://soundcloud.app.goo.gl/Hqa78gdDiUTcPHxc7");
    expect(out.url).toBe("https://soundcloud.app.goo.gl/Hqa78gdDiUTcPHxc7");
    expect(out.resolved).toBe(false);
    expect(out.reason).toBe("dead-destination");
    expect(out.finalStatus).toBe(404);
    // Still reported, so a failure CSV can say what it pointed at.
    expect(out.destination).toBe("https://soundcloud.com/ahuraaghabeigi");
  });

  it("does not strip the query string — canonicalization is someone else's job", async () => {
    mockChain(
      redirectTo("https://soundcloud.com/lolakind?ref=clipboard&si=991E3000"),
      destination(200)
    );
    const out = await resolveRedirect("https://on.soundcloud.com/SGLfUfT6l0kTYyO1SY");
    expect(out.url).toBe("https://soundcloud.com/lolakind?ref=clipboard&si=991E3000");
  });

  it("falls back to GET when the host rejects HEAD", async () => {
    const spy = mockChain(redirectTo(null, 405), redirectTo("https://soundcloud.com/x"), destination(200));
    const out = await resolveRedirect("https://bit.ly/abc");
    expect(out.url).toBe("https://soundcloud.com/x");
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ method: "HEAD" });
    expect(spy.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
  });

  it("keeps the original when the Location header is malformed", async () => {
    mockChain(redirectTo("http://"));
    const out = await resolveRedirect("https://bit.ly/abc");
    expect(out.url).toBe("https://bit.ly/abc");
    expect(out.reason).toBe("network-error");
  });

  it("keeps the original when fetch throws", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
    const out = await resolveRedirect("https://bit.ly/abc");
    expect(out).toMatchObject({ url: "https://bit.ly/abc", resolved: false, reason: "network-error" });
  });

  it("reports a timeout distinctly from a network error", async () => {
    vi.spyOn(global, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );
    const out = await resolveRedirect("https://bit.ly/abc", { timeoutMs: 20 });
    expect(out.url).toBe("https://bit.ly/abc");
    expect(out.reason).toBe("timeout");
  });

  it("bounds the whole chain, not each hop, with timeoutMs", async () => {
    // Three slow-ish hops that would each pass a per-request budget but blow a
    // shared one. The chain must abort rather than take maxHops * timeoutMs.
    vi.spyOn(global, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((resolve, reject) => {
          (init as RequestInit).signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
          setTimeout(() => resolve(redirectTo("https://bit.ly/next")), 30);
        })
    );
    const started = performance.now();
    const out = await resolveRedirect("https://bit.ly/1", { timeoutMs: 50, maxHops: 5 });
    const elapsed = performance.now() - started;
    expect(out.reason).toBe("timeout");
    expect(elapsed).toBeLessThan(150); // not 5 * 30ms of hops, nor 5 * 50ms
  });
});

describe("resolveRedirect — tier A destination validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a share link that lands on the expected platform", async () => {
    mockChain(redirectTo("https://soundcloud.com/lolakind"), destination(200));
    const out = await resolveRedirect("https://on.soundcloud.com/SGLfUfT6l0kTYyO1SY");
    expect(out).toMatchObject({ url: "https://soundcloud.com/lolakind", resolved: true });
  });

  it("rejects a share link that lands somewhere else entirely", async () => {
    mockChain(redirectTo("https://login.example.com/blocked"), destination(200));
    const out = await resolveRedirect("https://on.soundcloud.com/8KP9u6WaRSeo1ycHww");
    expect(out.url).toBe("https://on.soundcloud.com/8KP9u6WaRSeo1ycHww");
    expect(out.reason).toBe("validation-failed");
    expect(out.destination).toBe("https://login.example.com/blocked");
  });

  it("rejects a redirect that lands back on the share host", async () => {
    mockChain(redirectTo("https://on.soundcloud.com/other"), destination(200));
    const out = await resolveRedirect("https://on.soundcloud.com/first");
    expect(out.reason).toBe("validation-failed");
  });

  it("rejects spotify.link's Branch deep link", async () => {
    // Probed live 2026-08-08: spotify.link/<id> -> spotify.app.link/<id>?_p=...
    // across three samples. That's not a profile, and storing it would be
    // strictly worse than keeping the original.
    mockChain(
      redirectTo("https://spotify.app.link/eqRHE9U72Db?_p=c21029c4981c67f0"),
      destination(200)
    );
    const out = await resolveRedirect("https://spotify.link/eqRHE9U72Db");
    expect(out.url).toBe("https://spotify.link/eqRHE9U72Db");
    expect(out.reason).toBe("validation-failed");
  });

  it("accepts spotify.link if it ever starts resolving properly", async () => {
    mockChain(redirectTo("https://open.spotify.com/artist/abc123"), destination(200));
    const out = await resolveRedirect("https://spotify.link/eqRHE9U72Db");
    expect(out).toMatchObject({ url: "https://open.spotify.com/artist/abc123", resolved: true });
  });

  it("rejects vm.tiktok.com's bot-blocked bounce to the homepage", async () => {
    // Probed live 2026-08-08: vm.tiktok.com/<id> -> tiktok.com/?_r=1 across
    // three samples. Right host, no profile — which is why the check requires
    // a /@handle path rather than just the domain.
    mockChain(redirectTo("https://www.tiktok.com/?_r=1"), destination(200));
    const out = await resolveRedirect("https://vm.tiktok.com/ZSKeHLQN");
    expect(out.url).toBe("https://vm.tiktok.com/ZSKeHLQN");
    expect(out.reason).toBe("validation-failed");
  });

  it("accepts a vm.tiktok.com link that reaches a real profile", async () => {
    mockChain(redirectTo("https://www.tiktok.com/@someartist"), destination(200));
    const out = await resolveRedirect("https://vm.tiktok.com/ZSKeHLQN");
    expect(out).toMatchObject({ url: "https://www.tiktok.com/@someartist", resolved: true });
  });

  it("validates fb.me against facebook.com", async () => {
    mockChain(redirectTo("https://www.facebook.com/someartist"), destination(200));
    await expect(resolveRedirect("https://fb.me/someartist")).resolves.toMatchObject({
      resolved: true,
    });

    vi.restoreAllMocks();
    mockChain(redirectTo("https://www.instagram.com/someartist"), destination(200));
    await expect(resolveRedirect("https://fb.me/someartist")).resolves.toMatchObject({
      resolved: false,
      reason: "validation-failed",
    });
  });

  it("does not validate tier B — any live destination is accepted", async () => {
    mockChain(redirectTo("https://anything-at-all.example.com/page"), destination(200));
    const out = await resolveRedirect("https://bit.ly/abc");
    expect(out).toMatchObject({ url: "https://anything-at-all.example.com/page", resolved: true });
  });
});

describe("resolveRedirect — never-throws contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the original for every failure mode instead of throwing", async () => {
    // The forms call this on a user's submitted link. A throw here would lose
    // their input to a transient network blip, so the contract is absolute.
    const cases: Array<[string, () => void]> = [
      ["fetch rejects", () => void vi.spyOn(global, "fetch").mockRejectedValue(new Error("boom"))],
      [
        "fetch resolves with garbage",
        () => void vi.spyOn(global, "fetch").mockResolvedValue({} as unknown as Response),
      ],
      [
        "headers.get throws",
        () =>
          void vi.spyOn(global, "fetch").mockResolvedValue({
            status: 302,
            headers: {
              get: () => {
                throw new Error("bad headers");
              },
            },
            body: null,
          } as unknown as Response),
      ],
      [
        "body.cancel rejects",
        () =>
          void vi.spyOn(global, "fetch").mockResolvedValue({
            status: 200,
            headers: { get: () => null },
            body: { cancel: () => Promise.reject(new Error("nope")) },
          } as unknown as Response),
      ],
    ];

    for (const [label, setup] of cases) {
      vi.restoreAllMocks();
      setup();
      const out = await resolveRedirect("https://bit.ly/abc");
      expect(out.url, label).toBe("https://bit.ly/abc");
      expect(out.resolved, label).toBe(false);
    }
  });

  it("handles empty and malformed input without a network call", async () => {
    const spy = vi.spyOn(global, "fetch");
    for (const input of ["", "   ", "not a url", "http://"]) {
      const out = await resolveRedirect(input);
      expect(out.resolved).toBe(false);
      expect(out.reason).toBe("not-resolvable");
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
