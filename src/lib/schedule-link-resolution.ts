// ============================================================
// Schedules link resolution to run AFTER the response is sent.
//
// The save paths store whatever the user typed, canonicalized only by the
// synchronous rules in profile-links.ts, and hand off to this. A moment
// later the row tidies itself: a shortener or share link is followed to its
// real destination, reclassified, and rewritten.
//
// Why this isn't done inline. Until now the save paths awaited
// resolveProfileLinkUrlAsync, which made at most ONE network call, only for
// on.soundcloud.com, only on the SoundCloud field. Widening resolution to
// every shortener host (the point of this work) would have turned that into
// one sequential round-trip PER LINK on the critical path — a submission
// with five shortened links paying five timeouts before the user sees
// anything. after() keeps the save instant and moves the cost off the
// response.
//
// The consequence to accept: the page rendered immediately after the save
// shows the unresolved URL until something revalidates. That is a link
// tidying itself a beat later, not a correctness problem, so it is left
// alone deliberately rather than papered over with a revalidate.
//
// Durability: none, by design. after() has no retry, and a callback lost to
// a cold start or a deploy leaves the row unresolved. That is fine because
// it is not the only mechanism — scripts/resolve-link-redirects.mjs finds
// any row whose host is resolvable, no matter why it is still there, so a
// dropped callback is picked up by the next backfill run. The two cannot
// drift apart because neither keeps state.
//
// Lives here rather than in resolve-artist-links.ts because that module is
// imported by scripts/ under tsx, and importing next/server there would drag
// the framework into a plain Node script.
// ============================================================

import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveArtistLinks } from "./resolve-artist-links";

/**
 * Resolves this artist's shortened/share links once the response has gone out.
 *
 * Safe to call unconditionally after saving links: if none of them need
 * resolving, the scan finds nothing and makes no network calls.
 *
 * `delayMs: 0` because the per-request throttle the batch scripts use exists
 * to be polite across hundreds of rows; one artist has a handful of links and
 * pacing them would just hold the serverless invocation open longer.
 */
export function scheduleLinkResolution(client: SupabaseClient, artistId: string): void {
  after(async () => {
    try {
      await resolveArtistLinks(client, { artistId }, { delayMs: 0 });
    } catch (e) {
      // Never rethrow: this runs detached from the request, so an unhandled
      // rejection here would surface as a server error for a save that
      // already succeeded.
      console.error(`resolveArtistLinks(${artistId}) failed:`, e);
    }
  });
}
