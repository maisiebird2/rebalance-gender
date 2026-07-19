#!/usr/bin/env node
/**
 * prune-lastfm-multi-artist.mjs
 *
 * Removes Last.fm links that point at a "there is more than one artist with
 * this name" disambiguation page and marks them not-found.
 *
 * Why:
 *
 *   Last.fm data is pulled in to add per-artist detail that feeds the
 *   recommendation engine's parameters. When a Last.fm page actually covers
 *   several different acts sharing a name, its bio/tags/listeners describe a
 *   mix of people — that pollutes the signal, so the link is worth dropping
 *   entirely rather than keeping ambiguous data.
 *
 * How it detects them:
 *
 *   For each active Last.fm link (artist_links.platform = 'lastfm', url set,
 *   not_found = false) it calls the Last.fm API `artist.getInfo` and matches
 *   the returned bio against the patterns in ./lib/lastfm-multi-artist.mjs.
 *   The disambiguation notice ("There is more than one artist / band by the
 *   name of …", "There are several artists called …", etc.) heads the bio on
 *   such pages, so a hit reliably means "this page covers several acts".
 *
 *   The phrasings are user-contributed and vary a lot, so the patterns live in
 *   that lib as an editable list with unit tests over real harvested bios. To
 *   add more: run a --dry-run (which harvests every bio into the cache), then
 *   iterate offline against the cache with no further API calls.
 *
 * What it writes:
 *
 *   1. api_response_cache (namespace 'lastfm_info'): the full getInfo payload
 *      per link, keyed by the Last.fm URL. This is a durable harvest store —
 *      populated even on a dry run — so you can iterate on the patterns
 *      offline with ZERO further API calls. (Same no-TTL cache the other
 *      resolve/harvest scripts use; see supabase_migration_api_response_cache.sql.)
 *
 *   2. artist_links (only with --apply): each matched link is set to the
 *      not-found state { url: null, handle: null, not_found: true } — exactly
 *      what the artist edit form and mark-mismatch-not-found.py write. The
 *      original_url column is left untouched; the removed URL is also still
 *      recoverable from the printed report and the cached getInfo payload.
 *
 * SAFETY: dry-run by default. Without --apply it only reads artist_links,
 * fetches + caches getInfo, and prints the plan. It never deletes rows.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, LASTFM_API_KEY
 * Requires the api_response_cache table
 *   (supabase_migration_api_response_cache.sql), already in use by the
 *   resolve/harvest pipeline.
 *
 * Usage:
 *   node scripts/prune-lastfm-multi-artist.mjs                 # dry run: harvest + report
 *   node scripts/prune-lastfm-multi-artist.mjs --apply         # mark matches not-found
 *   node scripts/prune-lastfm-multi-artist.mjs --limit 20      # first N links only
 *   node scripts/prune-lastfm-multi-artist.mjs --artist "Cashu"# one artist by name
 *   node scripts/prune-lastfm-multi-artist.mjs --refetch       # bypass cache, re-call getInfo
 *   node scripts/prune-lastfm-multi-artist.mjs --report out.csv# also write a CSV of matches
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'
// Detection lives in the lib so it can be unit-tested against real harvested
// bios (see lastfm-multi-artist.test.mjs). Add new phrasings there.
import { matchMultiArtist, bioText } from './lib/lastfm-multi-artist.mjs'

// ── Environment ─────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url))
;(function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env.local')
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      const key = t.slice(0, eq).trim()
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (key && !(key in process.env)) process.env[key] = val
    }
  } catch { /* no .env.local — rely on existing env vars */ }
})()
const REQUIRED_VARS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'LASTFM_API_KEY']
const missing = REQUIRED_VARS.filter(k => !process.env[k])
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
)

// ── CLI ──────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const getArg  = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const hasFlag = name => argv.includes(name)
const OPT_APPLY   = hasFlag('--apply')
const OPT_LIMIT   = getArg('--limit') ? parseInt(getArg('--limit'), 10) : null
const OPT_ARTIST  = getArg('--artist')
const OPT_REFETCH = hasFlag('--refetch')
const OPT_REPORT  = getArg('--report')
const PAGE_SIZE   = 1000

// ── Logging ────────────────────────────────────────────────────────────────────
const fmt = (level, msg) => `${new Date().toTimeString().slice(0, 8)} ${level.padEnd(7)} ${msg}`
const log  = (msg, ...a) => console.log(fmt('INFO', msg), ...a)
const warn = (msg, ...a) => console.warn(fmt('WARNING', msg), ...a)
const err  = (msg, ...a) => console.error(fmt('ERROR', msg), ...a)

// ── Response cache (Supabase-backed, durable, no TTL) ───────────────────────────
// The getInfo payload is parked in api_response_cache so re-runs and offline
// pattern iteration skip the rate-limited call. Written even on a dry run — the
// harvest itself is not a mutation of app data; only artist_links writes are
// gated behind --apply. To force a refetch of a single row, delete it or pass
// --refetch.
const CACHE_NS = 'lastfm_info'
async function cacheGet(key) {
  const { data, error } = await supabase
    .from('api_response_cache')
    .select('payload')
    .eq('namespace', CACHE_NS)
    .eq('cache_key', key)
    .maybeSingle()
  if (error) { warn(`Cache read failed: ${error.message}`); return null }
  return data ? data.payload : null
}
async function cacheSet(key, value) {
  const { error } = await supabase
    .from('api_response_cache')
    .upsert(
      { namespace: CACHE_NS, cache_key: key, payload: value, fetched_at: new Date().toISOString() },
      { onConflict: 'namespace,cache_key' },
    )
  if (error) warn(`Cache write failed: ${error.message}`)
}

// ── Last.fm API ─────────────────────────────────────────────────────────────────
function makeThrottle(ms) {
  let last = 0
  return () => {
    const wait = ms - (Date.now() - last)
    if (wait <= 0) { last = Date.now(); return Promise.resolve() }
    return new Promise(r => setTimeout(() => { last = Date.now(); r() }, wait))
  }
}
const throttleLfm = makeThrottle(260) // Last.fm: ~4 req/s

// The stored URL is the canonical Last.fm page, e.g.
// https://www.last.fm/music/Artist+Name — the slug after /music/ is what the
// API expects as the artist name (URL-decoded, '+' → space). Mirrors
// harvest-genres-lastfm.mjs.
function artistNameFromUrl(url) {
  const slug = String(url).replace(/\/$/, '').split('/music/').pop()
  try { return decodeURIComponent(slug.replace(/\+/g, ' ')) } catch { return slug.replace(/\+/g, ' ') }
}

// Returns the raw getInfo payload, from cache when possible. `null` means the
// call failed hard (network/HTTP); a Last.fm "artist not found" (error 6) is
// returned as its normal payload so callers can distinguish it.
async function getInfo(url) {
  if (!OPT_REFETCH) {
    const hit = await cacheGet(url)
    if (hit !== null) return hit
  }
  await throttleLfm()
  const qs = new URLSearchParams({
    method: 'artist.getInfo',
    artist: artistNameFromUrl(url),
    api_key: process.env.LASTFM_API_KEY,
    format: 'json',
    autocorrect: '0', // stay on the exact page this link points at
  })
  let payload
  try {
    const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${qs}`, {
      headers: { 'User-Agent': 'WomenInElectronicMusicDirectory/1.0 (maisiemeson@gmail.com)' },
    })
    if (!res.ok) { warn(`getInfo HTTP ${res.status} for ${url}`); return null }
    payload = await res.json()
  } catch (e) {
    warn(`getInfo fetch failed for ${url}: ${e.message}`)
    return null
  }
  await cacheSet(url, payload)
  return payload
}

// ── DB helpers ──────────────────────────────────────────────────────────────────
async function fetchAllPages(buildQuery) {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1)
    if (error) throw error
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows
}

async function fetchLastfmLinks() {
  let links = await fetchAllPages((from, to) => supabase
    .from('artist_links')
    .select('id, artist_id, url, handle')
    .eq('platform', 'lastfm')
    .eq('not_found', false)
    .not('url', 'is', null)
    .order('id')
    .range(from, to))
  // Attach artist names for readable logs/report.
  const ids = [...new Set(links.map(l => l.artist_id))]
  const nameMap = {}
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const { data, error } = await supabase.from('artists').select('id, name').in('id', chunk)
    if (error) throw error
    for (const a of data ?? []) nameMap[a.id] = a.name
  }
  links = links.map(l => ({ ...l, name: nameMap[l.artist_id] ?? null }))
  if (OPT_ARTIST) {
    const needle = OPT_ARTIST.toLowerCase()
    links = links.filter(l => (l.name ?? '').toLowerCase() === needle
      || artistNameFromUrl(l.url).toLowerCase() === needle)
  }
  if (OPT_LIMIT != null) links = links.slice(0, OPT_LIMIT)
  return links
}

// Mark one lastfm link not-found. Targets by (artist_id, platform), which is
// unique (artist_links_artist_platform_unique), so this touches exactly the one
// row. The url-change trigger clears its stale enrichment sync flags.
async function markNotFound(artistId) {
  const { error } = await supabase
    .from('artist_links')
    .update({ url: null, handle: null, not_found: true })
    .eq('artist_id', artistId)
    .eq('platform', 'lastfm')
  if (error) throw new Error(error.message)
}

// ── Main ────────────────────────────────────────────────────────────────────────
async function main() {
  log(`prune-lastfm-multi-artist ${OPT_APPLY ? '(APPLY — writing)' : '(DRY RUN — read-only of artist_links)'}`)
  const links = await fetchLastfmLinks()
  log(`Examining ${links.length} active Last.fm link(s).`)

  const matched = []          // { name, artist_id, url, pattern }
  const byPattern = {}
  let notFoundPages = 0, fetchErrors = 0, examined = 0

  for (const link of links) {
    examined++
    const payload = await getInfo(link.url)
    if (payload === null) { fetchErrors++; continue }
    if (payload.error) {
      // e.g. error 6 = artist not found. Out of scope here (we only prune
      // multi-artist pages), but worth surfacing.
      notFoundPages++
      log(`  ? getInfo error ${payload.error} (${payload.message ?? ''}) — ${link.name ?? link.url}`)
      continue
    }
    const pattern = matchMultiArtist(bioText(payload))
    if (pattern) {
      matched.push({ ...link, pattern })
      byPattern[pattern] = (byPattern[pattern] ?? 0) + 1
      log(`  ✗ MULTI-ARTIST: ${link.name ?? '(no name)'}  ${link.url}`)
      log(`      matched /${pattern}/`)
    }
    if (examined % 50 === 0) log(`  … ${examined}/${links.length} examined`)
  }

  console.log('\n' + '-'.repeat(64))
  log(`Examined      : ${examined}`)
  log(`Multi-artist  : ${matched.length}`)
  for (const [p, n] of Object.entries(byPattern).sort((a, b) => b[1] - a[1])) {
    log(`    ${n.toString().padStart(4)}  /${p}/`)
  }
  if (notFoundPages) log(`getInfo "not found" pages (left as-is): ${notFoundPages}`)
  if (fetchErrors)   log(`Fetch errors (left as-is): ${fetchErrors}`)

  if (OPT_REPORT) {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const csv = ['artist_id,name,url,matched_pattern']
      .concat(matched.map(m => [m.artist_id, m.name, m.url, m.pattern].map(esc).join(',')))
      .join('\n')
    fs.writeFileSync(OPT_REPORT, csv + '\n')
    log(`Wrote report: ${OPT_REPORT} (${matched.length} row(s))`)
  }

  if (!OPT_APPLY) {
    console.log(`\nDry run — no artist_links rows changed. Re-run with --apply to mark`
      + ` the ${matched.length} matched link(s) not-found.`)
    return
  }

  let wrote = 0, writeErrors = 0
  for (const m of matched) {
    try {
      await markNotFound(m.artist_id)
      wrote++
    } catch (e) {
      writeErrors++
      err(`Failed to mark ${m.name ?? m.artist_id}: ${e.message}`)
    }
  }
  log(`Marked not-found: ${wrote}${writeErrors ? `, errors: ${writeErrors}` : ''}`)
}

main().catch(e => { err(e.stack || e.message); process.exit(1) })
