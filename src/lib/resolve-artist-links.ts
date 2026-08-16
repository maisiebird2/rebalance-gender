// ============================================================
// Row-level policy for resolving links already stored in artist_links.
//
// resolve-url-redirects.ts answers "where does this URL point?". This
// module decides what to DO about the answer for a live row: whether
// the platform changes, what the canonical form is, what the handle
// becomes, whether the original is worth preserving, and — the part
// that needs the most care — when to leave a row alone.
//
// Deliberately split from the network core so the core stays free of
// Supabase, and this stays free of fetch. See
// documentation/URL-RESOLUTION-PLAN.md.
//
// SERVER ONLY (it resolves URLs over the network, via the core).
//
// Three callers, one code path:
//
//   1. after() on the form save paths, scoped to { artistId } — the
//      user's save returns immediately and their shortened link
//      tidies itself a moment later.
//   2. scripts/resolve-link-redirects.mjs, scoped to { all: true } —
//      the backfill, and the safety net for any after() that failed.
//   3. Ad-hoc repair, scoped to { ids }.
//
// There is deliberately NO queue table. The set of rows needing work
// is exactly "rows whose host is in the tier table", which is fully
// derivable from the URL — so the scan below IS the queue and the
// backfill IS the drain. They cannot drift apart, and adding a host
// to the tier table automatically re-enqueues history.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { reclassifyResolvedUrl } from "./classify-platform-url";
import { canonicalizeResidentAdvisorUrl, deriveHandle, resolveProfileLinkUrl } from "./profile-links";
import { cleanLinkUrl } from "./platforms";
import {
  isResolvableHost,
  resolvableHosts,
  resolveRedirect,
  type ResolveFailureReason,
  type ResolveOptions,
} from "./resolve-url-redirects";

/** Why a row was left alone. The resolve-side reasons are passed through from
 *  the core; the rest are decisions this module made. */
export type SkipReason =
  | ResolveFailureReason
  /** Resolved, canonicalized, and came out identical to what's already stored. */
  | "unchanged"
  /** Reclassification would move the row onto a (artist_id, platform) slot the
   *  artist already occupies, with a DIFFERENT link in it. Needs a human. */
  | "platform-collision"
  /** Same as above, except the resolved URL is exactly what the occupying link
   *  already holds — so this row is a redundant copy of it, not a competing
   *  claim. Separated out because the two need completely different handling:
   *  one is a judgement call, the other is mechanical cleanup. */
  | "duplicate-of-existing"
  /** Reclassified to a key with no row in `platforms` — the FK would reject it. */
  | "unknown-platform"
  /** classifyPlatformUrl returned null: a policy-skipped host (twitter/x) or an
   *  unparseable/non-http destination. */
  | "unclassifiable"
  /** The UPDATE itself failed. */
  | "write-failed";

export interface RowOutcome {
  id: number;
  artistId: string;
  /** Platform and URL as they were before this run. */
  platform: string;
  url: string;
  /** Only on "updated" rows. */
  newPlatform?: string;
  newUrl?: string;
  newHandle?: string | null;
  status: "updated" | "skipped";
  reason?: SkipReason;
  /** On "platform-collision" only: the link already occupying the slot this row
   *  would have moved into. Both sides are needed to pick a winner. */
  conflictLinkId?: number;
  conflictUrl?: string | null;
  /** Where the link actually pointed, when that was discovered — including for
   *  skipped rows, so a report can explain the decision. */
  destination?: string | null;
  finalStatus?: number | null;
  /** Populated for "write-failed". */
  error?: string;
}

export type ResolveScope =
  | { artistId: string }
  | { ids: number[] }
  | { all: true };

export interface ResolveArtistLinksOptions {
  /** Decide everything and report it, write nothing. */
  dryRun?: boolean;
  /** Only rows whose URL contains this host. Backfill convenience. */
  host?: string;
  /** Cap on rows examined, for testing against production data. */
  limit?: number;
  /** Pause between network calls. Defaults to 150ms, matching the throttle the
   *  harvest scripts use. Pass 0 for a single-artist after() call, where the
   *  handful of links doesn't warrant it. */
  delayMs?: number;
  /** Forwarded to the network core (timeout, hop cap, user agent). */
  resolve?: ResolveOptions;
  onProgress?: (outcome: RowOutcome) => void;
}

export interface ResolveArtistLinksReport {
  updated: RowOutcome[];
  skipped: RowOutcome[];
  /** Rows examined — those whose host is resolvable. Not the size of the table. */
  examined: number;
}

interface ArtistLinkRow {
  id: number;
  artist_id: string;
  platform: string;
  url: string;
  original_url: string | null;
}

interface SlotRow {
  id: number;
  artist_id: string;
  platform: string;
  url: string | null;
}

/** The link occupying one (artist_id, platform) slot. */
interface SlotOccupant {
  id: number;
  url: string | null;
}

const DEFAULT_DELAY_MS = 150;
const PAGE_SIZE = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolves shortened/share URLs stored in artist_links and rewrites the rows.
 *
 * Idempotent: a second run over the same rows resolves nothing, because the
 * first run replaced the shortened URLs with their targets and a target is
 * never itself a resolvable host.
 *
 * Never throws for a single bad row — a row that can't be resolved, classified
 * or written is recorded in `skipped` and the run continues. A failure to READ
 * the table does throw, since that means the run didn't happen at all.
 */
export async function resolveArtistLinks(
  client: SupabaseClient,
  scope: ResolveScope,
  opts: ResolveArtistLinksOptions = {}
): Promise<ResolveArtistLinksReport> {
  const { dryRun = false, delayMs = DEFAULT_DELAY_MS, limit, host, resolve, onProgress } = opts;

  const candidates = await fetchCandidates(client, scope, { host, limit });
  const updated: RowOutcome[] = [];
  const skipped: RowOutcome[] = [];

  if (candidates.length === 0) return { updated, skipped, examined: 0 };

  // Valid platform keys, so a Tier B reclassification can't violate
  // artist_links_platform_fkey. Same guard 2d applies to staged rows — a
  // platform key can be added via the admin panel, and a re-run then promotes
  // the rows that were waiting on it.
  const validPlatforms = await fetchPlatformKeys(client);

  // Every (artist_id, platform) pair these artists already occupy, so a
  // reclassification onto a taken slot is caught before the write rather than
  // as a unique-constraint error afterwards.
  const takenSlots = await fetchTakenSlots(client, [...new Set(candidates.map((r) => r.artist_id))]);

  for (const [index, row] of candidates.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);

    const outcome = await decideRow(row, validPlatforms, takenSlots, resolve);

    if (outcome.status === "updated" && !dryRun) {
      const { error } = await client
        .from("artist_links")
        .update({
          url: outcome.newUrl,
          platform: outcome.newPlatform,
          handle: outcome.newHandle,
          // Preserve the pre-resolution URL, but only when nothing is recorded
          // yet — an existing original_url is a truer original than this one
          // (it predates whatever put the shortened link here). This is what
          // makes re-runs safe, and it mirrors resolve-residentadvisor-urls.mjs.
          ...(row.original_url ? {} : { original_url: row.url }),
        })
        .eq("id", row.id);

      if (error) {
        const failed: RowOutcome = {
          ...outcome,
          status: "skipped",
          reason: "write-failed",
          error: error.message,
        };
        skipped.push(failed);
        onProgress?.(failed);
        continue;
      }

      // Claim the slot so a later row in this same run can't be told the
      // platform is free when this row just took it, and release the one it
      // vacated so a later row can legitimately move in.
      takenSlots.set(slotKey(row.artist_id, outcome.newPlatform!), {
        id: row.id,
        url: outcome.newUrl!,
      });
      if (outcome.newPlatform !== row.platform) {
        takenSlots.delete(slotKey(row.artist_id, row.platform));
      }
    }

    if (outcome.status === "updated") updated.push(outcome);
    else skipped.push(outcome);
    onProgress?.(outcome);
  }

  return { updated, skipped, examined: candidates.length };
}

/** Decides what should happen to one row. Pure apart from the network call, so
 *  the dry run and the live run take exactly the same path. */
async function decideRow(
  row: ArtistLinkRow,
  validPlatforms: Set<string>,
  takenSlots: Map<string, SlotOccupant>,
  resolveOpts: ResolveOptions | undefined
): Promise<RowOutcome> {
  const base = { id: row.id, artistId: row.artist_id, platform: row.platform, url: row.url };

  const result = await resolveRedirect(row.url, resolveOpts);
  if (!result.resolved) {
    return {
      ...base,
      status: "skipped",
      reason: result.reason,
      destination: result.destination,
      finalStatus: result.finalStatus,
    };
  }

  // Reclassify from the RESOLVED url, for BOTH tiers.
  //
  // It's tempting to skip this for Tier A on the grounds that the destination
  // platform was known up front — but that reasoning confuses "we knew what the
  // destination would be" with "the stored platform is right". A
  // soundcloud.app.goo.gl row is stored as `other` precisely BECAUSE
  // classification ran on the shortener host before anything could resolve it;
  // keeping that platform would leave an obvious SoundCloud profile sitting
  // under `other` with a null handle. Resolution is exactly the moment that
  // becomes knowable, so it's the moment to fix it.
  //
  // The policy itself lives in classify-platform-url.ts, shared with stage 2d,
  // so staging rows and live rows are reclassified the same way.
  const reclassified = reclassifyResolvedUrl(result.url, row.platform);
  if (reclassified.kind === "refused") {
    return {
      ...base,
      status: "skipped",
      reason: "unclassifiable",
      destination: result.destination,
      finalStatus: result.finalStatus,
    };
  }
  const newPlatform = reclassified.platform;

  if (!validPlatforms.has(newPlatform)) {
    return {
      ...base,
      status: "skipped",
      reason: "unknown-platform",
      newPlatform,
      destination: result.destination,
      finalStatus: result.finalStatus,
    };
  }

  // Same canonicalization the save paths and 2d apply, so a resolved link is
  // stored in exactly the form it would have had if it were entered directly.
  //
  // Computed BEFORE the collision check below, even though a colliding row is
  // never written: a collision report is only actionable if it shows both
  // candidate URLs in their final form, so a reviewer can compare like with
  // like instead of a canonical URL against a raw shortener.
  const newUrl = resolveProfileLinkUrl(
    newPlatform,
    canonicalizeResidentAdvisorUrl(result.url),
    cleanLinkUrl
  );

  if (!newUrl) {
    return {
      ...base,
      status: "skipped",
      reason: "unclassifiable",
      destination: result.destination,
      finalStatus: result.finalStatus,
    };
  }

  if (newUrl === row.url && newPlatform === row.platform) {
    return {
      ...base,
      status: "skipped",
      reason: "unchanged",
      destination: result.destination,
      finalStatus: result.finalStatus,
    };
  }

  // artist_links carries UNIQUE (artist_id, platform), so moving a row to a
  // platform the artist already has would violate it. Which of the two links is
  // the better one isn't a call this module should make silently, so the row is
  // reported for a human instead — with the incumbent's id and URL, since
  // "these two links compete for one slot" is useless without both of them.
  const incumbent =
    newPlatform !== row.platform ? takenSlots.get(slotKey(row.artist_id, newPlatform)) : undefined;
  if (incumbent) {
    return {
      ...base,
      status: "skipped",
      // Plain equality rather than a fuzzy match: both URLs have been through
      // resolveProfileLinkUrl, so equal ones are genuinely identical, and
      // erring toward "needs a human" is the safe direction to be wrong in.
      reason: incumbent.url === newUrl ? "duplicate-of-existing" : "platform-collision",
      newPlatform,
      newUrl,
      conflictLinkId: incumbent.id,
      conflictUrl: incumbent.url,
      destination: result.destination,
      finalStatus: result.finalStatus,
    };
  }

  return {
    ...base,
    status: "updated",
    newPlatform,
    newUrl,
    // Derived from the RESOLVED url — the stored handle must describe where the
    // link now points, not the opaque shortener id it used to be.
    newHandle: deriveHandle(newPlatform, newUrl),
    destination: result.destination,
    finalStatus: result.finalStatus,
  };
}

const slotKey = (artistId: string, platform: string) => `${artistId}|${platform}`;

/** Rows in scope whose host is actually resolvable.
 *
 *  The SQL side is a loose `url ILIKE %host%` per known host — enough to avoid
 *  pulling 200k rows for the ~90 that matter — and the exact host test happens
 *  in JS afterwards. */
async function fetchCandidates(
  client: SupabaseClient,
  scope: ResolveScope,
  opts: { host?: string; limit?: number }
): Promise<ArtistLinkRow[]> {
  const hosts = opts.host ? [opts.host] : resolvableHosts();
  const orFilter = hosts.map((h) => `url.ilike.%${h}%`).join(",");

  const rows: ArtistLinkRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = client
      .from("artist_links")
      .select("id, artist_id, platform, url, original_url")
      .not("url", "is", null)
      .or(orFilter)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);

    if ("artistId" in scope) query = query.eq("artist_id", scope.artistId);
    else if ("ids" in scope) query = query.in("id", scope.ids);

    const { data, error } = await query;
    if (error) throw new Error(`Could not read artist_links: ${error.message}`);

    rows.push(...(data as ArtistLinkRow[]));
    if (data.length < PAGE_SIZE) break;
  }

  const resolvable = rows.filter((r) => r.url && isResolvableHost(r.url));
  return opts.limit ? resolvable.slice(0, opts.limit) : resolvable;
}

async function fetchPlatformKeys(client: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await client.from("platforms").select("key");
  if (error) throw new Error(`Could not read platforms: ${error.message}`);
  return new Set((data as { key: string }[]).map((p) => p.key));
}

/** Every (artist_id, platform) slot these artists occupy, mapped to the link
 *  sitting in it. The occupant's id and URL are carried so a collision can be
 *  reported with both competing links rather than just the fact of the clash. */
async function fetchTakenSlots(
  client: SupabaseClient,
  artistIds: string[]
): Promise<Map<string, SlotOccupant>> {
  const slots = new Map<string, SlotOccupant>();
  for (let i = 0; i < artistIds.length; i += 200) {
    const batch = artistIds.slice(i, i + 200);
    const { data, error } = await client
      .from("artist_links")
      .select("id, artist_id, platform, url")
      .in("artist_id", batch);
    if (error) throw new Error(`Could not read existing platforms: ${error.message}`);
    for (const r of data as SlotRow[]) {
      slots.set(slotKey(r.artist_id, r.platform), { id: r.id, url: r.url });
    }
  }
  return slots;
}
