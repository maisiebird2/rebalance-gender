// ============================================================
// Network-level retry for Supabase queries.
//
// supabase-js (postgrest-js) never rejects on a network failure — it
// catches the fetch rejection and returns it as the response's
// `error`, with message "TypeError: fetch failed", response status 0,
// and the original stack in `details`. The underlying reason
// (ECONNRESET, ENOTFOUND, a TLS blip, …) is dropped in that wrapping.
// The bulk scripts all follow an `if (error) throw error` pattern, so
// without a retry a single dropped packet during a bootstrap query is
// fatal to the whole run — and, under
// orchestrate-platform-enrichment.mjs, to the whole orchestration
// (diagnosed on a 2026-07-24 run: sync-soundcloud died between "State
// loaded" and its first artist, on one of its paged preload queries).
//
// runWithNetworkRetry(runQuery) re-runs the query with a short
// backoff when — and only when — the failure is network-shaped:
//
//   • the postgrest wrapper's marker for "no HTTP response at all"
//     (response status 0), or a connectivity-looking error message;
//   • a rejected promise whose error looks the same (raw fetch
//     callers, e.g. Storage, don't get the postgrest wrapping).
//
// HTTP-level errors (4xx/5xx from PostgREST) are returned unchanged
// on the first attempt: those are real answers from the server, not
// connectivity blips, and retrying them would only mask real bugs.
// The final failing response/rejection is returned/rethrown as-is,
// so callers keep their existing `if (error) throw error` handling.
// ============================================================

const NETWORK_ERROR_REGEX =
  /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|terminated/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is this response/error a network-level failure (the request never
 * got an HTTP response), as opposed to a real answer from PostgREST?
 *
 * @param {{ error?: { message?: string } | null, status?: number } | null} response
 *   A supabase response object, or null when testing a thrown error.
 * @param {unknown} [thrown] — an error a query rejected with, for raw
 *   (non-postgrest) callers.
 */
export function isNetworkFailure(response, thrown = undefined) {
  if (thrown !== undefined) {
    const msg = thrown instanceof Error ? `${thrown.message} ${thrown.cause?.message ?? ""}` : String(thrown);
    return NETWORK_ERROR_REGEX.test(msg);
  }
  if (!response?.error) return false;
  // postgrest-js sets response.status to 0 when fetch itself rejected.
  if (response.status === 0) return true;
  return NETWORK_ERROR_REGEX.test(response.error.message ?? "");
}

/**
 * Run a Supabase query, retrying network-level failures.
 *
 * @param {() => PromiseLike<any>} runQuery — builds AND awaits the
 *   query (a fresh builder each attempt; postgrest builders are
 *   single-use thenables, so the caller must construct inside).
 * @param {{ label?: string, delaysMs?: number[], sleepFn?: (ms: number) => Promise<void> }} [opts]
 *   label    — used in the retry warning, e.g. "resolved_artists page".
 *   delaysMs — backoff before each retry; its length sets the retry
 *              count (default [1000, 4000] → 3 attempts total).
 *   sleepFn  — injectable for tests.
 * @returns the last response (network failures included, so callers'
 *   `if (error) throw error` still fires after retries run out).
 */
export async function runWithNetworkRetry(runQuery, { label = "supabase query", delaysMs = [1000, 4000], sleepFn = sleep } = {}) {
  const attempts = delaysMs.length + 1;
  let lastThrown;
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await runQuery();
    } catch (err) {
      // Raw fetch callers reject instead of returning { error }. Only
      // network-shaped rejections are retried; anything else (a bug,
      // an abort) propagates immediately.
      if (!isNetworkFailure(null, err) || attempt >= attempts) throw err;
      lastThrown = err;
      response = null;
    }
    if (response !== null) {
      if (!isNetworkFailure(response) || attempt >= attempts) return response;
      lastThrown = response.error;
    }
    const delay = delaysMs[attempt - 1];
    console.warn(
      `  (network failure on ${label} — ${lastThrown?.message ?? lastThrown}; retrying in ${delay / 1000}s, attempt ${attempt + 1}/${attempts})`
    );
    await sleepFn(delay);
  }
}
