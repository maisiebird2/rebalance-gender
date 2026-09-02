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
import { OVERFLOW_PLATFORM } from "./assign-platforms";
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
  /** No longer produced. Reclassification onto an occupied slot with a
   *  DIFFERENT link in it used to be reported here for a human to arbitrate;
   *  it is now an ordinary overflow — the row keeps its URL rewrite and moves
   *  to "other", the same answer assignPlatforms gives everywhere else. Kept
   *  in the union because stored reports and the backfill's CSV columns still
   *  name it. */
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
  | "write-failed"
  /** The DELETE of a redundant duplicate failed. */
  | "delete-failed";

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
  status: "updated" | "skipped" | "deleted";
  reason?: SkipReason;
  /** On "platform-collision" and "duplicate-of-existing": the link already
   *  occupying the slot this row would have moved into. For a collision both
   *  sides are needed to pick a winner; for a duplicate it names the row that
   *  makes this one redundant. */
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
  /**
   * Only rows belonging to an artist in the live directory
   * (`directory_status = 'approved'`, not soft-deleted).
   *
   * A backfill convenience, not a policy: resolution is just as correct for a
   * pending or `sc_followee` artist, and the unfiltered run is still the one
   * that drains every after() that never ran. But most of artist_links hangs
   * off artists nobody can see yet, and each row costs a network round trip —
   * so when the point of the run is "fix the links on the pages people
   * actually load", this cuts the work to those rows.
   */
  approvedOnly?: boolean;
  /** Cap on rows examined, for testing against production data. */
  limit?: number;
  /** Pause between network calls. Defaults to 150ms, matching the throttle the
   *  harvest scripts use. Pass 0 for a single-artist after() call, where the
   *  handful of links doesn't warrant it. */
  delayMs?: number;
  /** Forwarded to the network core (timeout, hop cap, user agent). */
  resolve?: ResolveOptions;
  /**
   * Delete rows whose resolved URL is EXACTLY what the artist already holds
   * under the right platform — the "duplicate-of-existing" outcome.
   *
   * Off by default, and deliberately so. This module's contract is otherwise
   * "rewrite rows, never remove them", which is what makes it safe to run from
   * a form save; nobody saving a link expects a different row to disappear.
   * Only the backfill turns this on, and only when asked.
   *
   * Nothing is lost when it does: the row being removed is an unresolved
   * shortener under the wrong platform, pointing at a destination the surviving
   * row already stores in canonical form, with a handle this one lacks.
   *
   * Never deletes on "platform-collision" — that is a genuinely different link,
   * and choosing between two of those is a person's call.
   */
  deleteDuplicates?: boolean;
  onProgress?: (outcome: RowOutcome) => void;
}

export interface ResolveArtistLinksReport {
  updated: RowOutcome[];
  skipped: RowOutcome[];
  /** Redundant duplicates removed. Always empty unless `deleteDuplicates` is
   *  set; populated but unwritten in a dry run. */
  deleted: RowOutcome[];
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
  const {
    dryRun = false,
    delayMs = DEFAULT_DELAY_MS,
    limit,
    host,
    approvedOnly = false,
    resolve,
    deleteDuplicates = false,
    onProgress,
  } = opts;

  const candidates = await fetchCandidates(client, scope, { host, limit, approvedOnly });
  const updated: RowOutcome[] = [];
  const skipped: RowOutcome[] = [];
  const deleted: RowOutcome[] = [];

  if (candidates.length === 0) return { updated, skipped, deleted, examined: 0 };

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
      //
      // "other" is never claimed: it is the overflow bucket, which holds as
      // many rows as it needs to, so treating it as a slot would make the
      // second overflow row in a run collide with the first.
      if (outcome.newPlatform !== OVERFLOW_PLATFORM) {
        takenSlots.set(slotKey(row.artist_id, outcome.newPlatform!), {
          id: row.id,
          url: outcome.newUrl!,
        });
      }
      if (outcome.newPlatform !== row.platform) {
        takenSlots.delete(slotKey(row.artist_id, row.platform));
      }
    }

    // A redundant duplicate: this row resolves to precisely what the artist
    // already holds under the right platform, so removing it loses nothing.
    // Opt-in only — see the deleteDuplicates docs.
    if (deleteDuplicates && outcome.reason === "duplicate-of-existing") {
      const removal: RowOutcome = { ...outcome, status: "deleted", reason: "duplicate-of-existing" };

      if (!dryRun) {
        const { error } = await client.from("artist_links").delete().eq("id", row.id);
        if (error) {
          const failed: RowOutcome = {
            ...outcome,
            status: "skipped",
            reason: "delete-failed",
            error: error.message,
          };
          skipped.push(failed);
          onProgress?.(failed);
          continue;
        }
        // The row is gone, so its slot is genuinely free now. Releasing it lets
        // a later row in this same run legitimately move into that platform.
        takenSlots.delete(slotKey(row.artist_id, row.platform));
      }

      deleted.push(removal);
      onProgress?.(removal);
      continue;
    }

    if (outcome.status === "updated") updated.push(outcome);
    else skipped.push(outcome);
    onProgress?.(outcome);
  }

  return { updated, skipped, deleted, examined: candidates.length };
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

  // The artist already holds the platform this row resolved to. There are two
  // quite different situations behind that, and they are told apart by plain
  // equality — both URLs have been through resolveProfileLinkUrl, so equal
  // ones are genuinely identical.
  const incumbent =
    newPlatform !== row.platform ? takenSlots.get(slotKey(row.artist_id, newPlatform)) : undefined;
  if (incumbent) {
    // A redundant copy of a link the artist already has. Still not a link
    // worth keeping twice — overflow is for DIFFERENT links, not copies — so
    // this outcome is unchanged.
    if (incumbent.url === newUrl) {
      return {
        ...base,
        status: "skipped",
        reason: "duplicate-of-existing",
        newPlatform,
        newUrl,
        conflictLinkId: incumbent.id,
        conflictUrl: incumbent.url,
        destination: result.destination,
        finalStatus: result.finalStatus,
      };
    }

    // A genuinely different link on a slot the artist already holds. This used
    // to be reported as "platform-collision" for a human to arbitrate, because
    // UNIQUE (artist_id, platform) left nowhere to put it. There is somewhere
    // now: supabase_migration_artist_links_overflow.sql freed the "other"
    // bucket, and filing it there is the same rule assignPlatforms applies to
    // the form and to ingestion — the first link on a host is the primary,
    // anything after it overflows. The URL rewrite is kept either way: the
    // whole point of resolving was to stop storing an opaque shortener.
    //
    // The incumbent is still reported alongside, so a report can show which
    // link took the slot.
    const overflowUnchanged = row.platform === OVERFLOW_PLATFORM && newUrl === row.url;
    if (overflowUnchanged) {
      return {
        ...base,
        status: "skipped",
        reason: "unchanged",
        destination: result.destination,
        finalStatus: result.finalStatus,
      };
    }
    return {
      ...base,
      status: "updated",
      newPlatform: OVERFLOW_PLATFORM,
      newUrl,
      // By the stored platform, so handle and platform never disagree — an
      // "other" row carries no handle.
      newHandle: deriveHandle(OVERFLOW_PLATFORM, newUrl),
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
  opts: { host?: string; limit?: number; approvedOnly?: boolean }
): Promise<ArtistLinkRow[]> {
  const hosts = opts.host ? [opts.host] : resolvableHosts();
  const orFilter = hosts.map((h) => `url.ilike.%${h}%`).join(",");
  // The embedded artists row is only there to be filtered on, so it is joined
  // in solely when asked — an unconditional !inner would change the default
  // scan's shape (and its cost) for every caller to serve one flag.
  // Typed as a plain string rather than a literal: supabase-js parses literal
  // column lists at the type level and rejects a union of two of them, so the
  // row type is recovered by the cast below (the same trade queries.ts makes).
  const columns: string = opts.approvedOnly
    ? "id, artist_id, platform, url, original_url, artists!inner(directory_status, deleted)"
    : "id, artist_id, platform, url, original_url";

  const rows: ArtistLinkRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = client
      .from("artist_links")
      .select(columns)
      .not("url", "is", null)
      .or(orFilter)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);

    if ("artistId" in scope) query = query.eq("artist_id", scope.artistId);
    else if ("ids" in scope) query = query.in("id", scope.ids);
    // Soft-deleted artists are excluded alongside the status check: a deleted
    // row keeps whatever directory_status it had, so approved-and-deleted is a
    // real combination, and it is not on the site either.
    if (opts.approvedOnly) {
      query = query.eq("artists.directory_status", "approved").eq("artists.deleted", false);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Could not read artist_links: ${error.message}`);

    rows.push(...((data ?? []) as unknown as ArtistLinkRow[]));
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
