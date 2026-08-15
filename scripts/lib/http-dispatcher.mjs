// ============================================================
// Process-wide HTTP dispatcher: forces HTTP/1.1 for every fetch().
//
// Import this — for its side effect — as the FIRST import of any
// scripts/ entry point that talks to the network (first, so the
// dispatcher is registered before any other imported module's
// top-level code can fetch):
//
//   import "./lib/http-dispatcher.mjs";
//
// Why this exists (diagnosed in store-images.mjs 2026-07-24; history
// in documentation/PIPELINE.md, "5b. store-images.mjs"): undici 8 — the
// npm package AND the copy bundled into Node ≥26's built-in fetch —
// negotiates HTTP/2 by default (`allowH2` defaults to true in
// undici/lib/core/connect.js), and HTTP/2 multiplexes every request
// to an origin over ONE shared session. When that session dies
// mid-run (a single TLS error is enough — the observed trigger was
// an "SSL alert bad record mac" during a bulk store-images run),
// undici keeps dispatching onto the destroyed session instead of
// evicting it from its pool, so EVERY later request to that origin
// fails with "ERR_HTTP2_INVALID_SESSION: The session has been
// destroyed" until the process restarts. In-process retries can't
// help — they get routed onto the same dead session. For a bulk
// script, one network blip kills the rest of the run.
//
// `allowH2: false` keeps everything on HTTP/1.1, where connections
// are independent: a TLS/socket failure kills at most its own
// in-flight request, the pool discards that one dead socket, and the
// next attempt reconnects cleanly — the failure model per-request
// retry loops are actually built for. The short keepAliveTimeout is
// a secondary mitigation: idle sockets get discarded quickly instead
// of lingering long enough for a proxy/load-balancer to close them
// server-side without the client noticing.
//
// setGlobalDispatcher registers the Agent process-wide — undici
// stores it under a Symbol.for key that Node's built-in fetch reads
// too, so plain global fetch() calls are covered, not just callers
// that pass { dispatcher } explicitly.
// ============================================================

import { Agent, setGlobalDispatcher } from "undici";

export const dispatcher = new Agent({
  allowH2: false,
  keepAliveTimeout: 4000,
  keepAliveMaxTimeout: 4000,
  // Forcing HTTP/1.1 put every response through undici's h1 parser,
  // whose default header budget is 16 KiB TOTAL across a response's
  // headers — and PostgREST echoes the full request path + query
  // string back in a Content-Location response header. A supabase
  // .in() filter with 500 UUIDs (the bulk scripts' usual chunk size)
  // makes that one header ~20 KiB, so the parser throws
  // HeadersOverflowError (UND_ERR_HEADERS_OVERFLOW), surfaced as
  // "TypeError: fetch failed", on EVERY such request — a query shape
  // that worked fine over HTTP/2 (diagnosed in sync-soundcloud.mjs
  // 2026-07-25; probe showed overflow from ~400 UUIDs up, and that the
  // server itself answers 200 even at 500). 256 KiB clears the largest
  // chunked query many times over while still bounding a hostile
  // server's memory use.
  maxHeaderSize: 256 * 1024,
});

setGlobalDispatcher(dispatcher);
