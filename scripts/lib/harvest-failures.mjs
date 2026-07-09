// ============================================================
// Shared helpers for the harvest_failures table (see
// supabase_migration_harvest_failures.sql and scripts/PIPELINE.md,
// "Persist harvest failures as queryable data").
//
// One row per (artist_id, service) holding the *current* failure for
// that pair. recordFailure() upserts the latest failure (overwriting
// whatever was there before — this table tracks "what's currently
// broken", not a historical log). clearFailure() removes the row once
// an artist succeeds, so a later successful run doesn't leave a stale
// failure sitting around.
//
// Used by scripts/sync-soundcloud.mjs; intended to be reused by future
// Phase 2 harvesters (Discogs, Linktree, Bandcamp, …) instead of each
// one inventing its own failure-tracking shape.
// ============================================================

/**
 * Record (or overwrite) the current failure for an (artist_id, service)
 * pair.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ artistId: string, service: string, status: string, detail?: string|null, url?: string|null }} params
 *   status   — short machine-readable code, e.g. 'wrong_field_url',
 *              'resolve_404', 'resolve_failed', 'write_failed'.
 *   detail   — free-text human-readable reason (HTTP status, error
 *              message, offending domain, etc.).
 *   url      — the offending URL, where relevant (e.g. the wrong-
 *              platform link that tripped the pre-check guard).
 */
export async function recordFailure(supabase, { artistId, service, status, detail = null, url = null }) {
  const { error } = await supabase.from("harvest_failures").upsert(
    {
      artist_id: artistId,
      service,
      status,
      detail,
      url,
      occurred_at: new Date().toISOString(),
    },
    { onConflict: "artist_id,service" }
  );
  if (error) {
    console.error(`  (failed to record harvest failure for ${artistId}/${service}: ${error.message})`);
  }
}

/**
 * Clear any existing failure row for an (artist_id, service) pair —
 * call this on success so the table only ever reflects current,
 * unresolved problems. A no-op (cheap) if no row exists.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ artistId: string, service: string }} params
 */
export async function clearFailure(supabase, { artistId, service }) {
  const { error } = await supabase
    .from("harvest_failures")
    .delete()
    .eq("artist_id", artistId)
    .eq("service", service);
  if (error) {
    console.error(`  (failed to clear harvest failure for ${artistId}/${service}: ${error.message})`);
  }
}

/**
 * Load { artist_id -> url } for every current failure of a given
 * service (optionally filtered to one status), so a caller can detect
 * "this artist's stored link has changed since it last failed" and
 * retry just that artist instead of requiring --force to reprocess
 * everyone. Needed specifically for failures that mark the artist
 * processed in resolved_artists (today, just 'resolve_404' — a
 * definitive dead link is otherwise permanently skipped even after a
 * human fixes the underlying artist_links row, since resolved_artists
 * only tracks "done for this artist_id", not which URL was checked).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ service: string, status?: string|null }} params
 * @returns {Promise<Map<string, string>>}
 */
export async function loadFailureUrls(supabase, { service, status = null }) {
  const PAGE_SIZE = 1000;
  const map = new Map();
  let from = 0;
  while (true) {
    let query = supabase
      .from("harvest_failures")
      .select("artist_id, url")
      .eq("service", service)
      .order("artist_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw error;

    for (const r of data ?? []) {
      if (r.url) map.set(r.artist_id, r.url);
    }
    if ((data?.length ?? 0) < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return map;
}
