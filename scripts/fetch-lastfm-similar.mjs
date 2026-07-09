#!/usr/bin/env node
// ============================================================
// fetch-lastfm-similar.mjs
//
// For every directory artist that has a Last.fm link
// (platform = 'lastfm' in artist_links), calls
// artist.getSimilar and stores the results in
// lastfm_similar_artists.
//
// similar_artist_id is populated when the similar artist can be
// matched to an existing row in the artists table. Matching tries,
// in order: Last.fm URL (against artist_links platform=lastfm),
// MusicBrainz ID, then artist name. The Last.fm URL is the most
// reliable key since it's stable and unambiguous.
//
// Rate limit: Last.fm allows ~4 req/s; this script waits 250ms
// between calls. A full run over ~1,400 artists takes roughly
// 6–8 minutes.
//
// Usage (from rebalance-gender/):
//
//   node scripts/fetch-lastfm-similar.mjs
//   node scripts/fetch-lastfm-similar.mjs --limit=20
//   node scripts/fetch-lastfm-similar.mjs --force          # re-fetch cached
//   node scripts/fetch-lastfm-similar.mjs --name="bicep"
//   node scripts/fetch-lastfm-similar.mjs --resolve-only   # no API calls —
//                                                           # backfill similar_artist_id
//                                                           # for existing rows using
//                                                           # current artist_links state
//   node scripts/fetch-lastfm-similar.mjs --debug
//   DRY_RUN=1 node scripts/fetch-lastfm-similar.mjs
//
// Requires LASTFM_API_KEY in .env.local (not needed for --resolve-only).
// Results are cached to .cache/lastfm_similar/<encoded-name>.json.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ------------------------------------------------------------
// CLI / env
// ------------------------------------------------------------
const args = process.argv.slice(2)

const DRY_RUN       = process.env.DRY_RUN === '1' || args.includes('--dry-run')
const FORCE         = args.includes('--force')
const DEBUG         = args.includes('--debug')
const RESOLVE_ONLY  = args.includes('--resolve-only')

const limitArg    = args.find(a => a.startsWith('--limit='))
const nameArg     = args.find(a => a.startsWith('--name='))

const OPT_LIMIT       = limitArg ? parseInt(limitArg.split('=')[1], 10) : null
const OPT_NAME_FILTER = nameArg  ? nameArg.split('=').slice(1).join('=').toLowerCase() : null

const LFM_SIMILAR_LIMIT = 100   // max results to request from LFM per artist
const LFM_RATE_MS       = 250   // 4 req/s

// ------------------------------------------------------------
// Load .env.local
// ------------------------------------------------------------
function loadEnvLocal() {
  const envPath = path.join(__dirname, '..', '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}
loadEnvLocal()

const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL
const SECRET_KEY    = process.env.SUPABASE_SECRET_KEY
const LASTFM_API_KEY = process.env.LASTFM_API_KEY

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local')
  process.exit(1)
}
if (!LASTFM_API_KEY && !RESOLVE_ONLY) {
  console.error('Missing LASTFM_API_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
})

// ------------------------------------------------------------
// Disk cache
// ------------------------------------------------------------
const CACHE_DIR = path.join(__dirname, '..', '.cache', 'lastfm_similar')
fs.mkdirSync(CACHE_DIR, { recursive: true })

function cacheKey(lfmName) {
  // Safe filename: replace slashes and other problematic chars
  const safe = encodeURIComponent(lfmName).replace(/%/g, '_')
  return path.join(CACHE_DIR, `${safe}.json`)
}

function cacheRead(lfmName) {
  const fp = cacheKey(lfmName)
  if (!fs.existsSync(fp)) return null
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')) } catch { return null }
}

function cacheWrite(lfmName, data) {
  fs.writeFileSync(cacheKey(lfmName), JSON.stringify(data))
}

// ------------------------------------------------------------
// Last.fm API
// ------------------------------------------------------------
let lastLfmRequest = 0

async function lfmGetSimilar(artistName) {
  if (!FORCE) {
    const cached = cacheRead(artistName)
    if (cached) return cached
  }

  const now = Date.now()
  const wait = LFM_RATE_MS - (now - lastLfmRequest)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastLfmRequest = Date.now()

  const url = new URL('https://ws.audioscrobbler.com/2.0/')
  url.searchParams.set('method', 'artist.getSimilar')
  url.searchParams.set('artist', artistName)
  url.searchParams.set('autocorrect', '1')
  url.searchParams.set('limit', String(LFM_SIMILAR_LIMIT))
  url.searchParams.set('api_key', LASTFM_API_KEY)
  url.searchParams.set('format', 'json')

  if (DEBUG) console.log(`  → GET ${url.toString().replace(LASTFM_API_KEY, '***')}`)

  const res = await fetch(url.toString())
  if (!res.ok) {
    throw new Error(`Last.fm HTTP ${res.status}`)
  }

  const data = await res.json()

  if (data.error) {
    throw new Error(`Last.fm error ${data.error}: ${data.message}`)
  }

  cacheWrite(artistName, data)
  return data
}

// ------------------------------------------------------------
// URL normalisation for Last.fm URLs
// Strips scheme, www., trailing slash so that
// "https://www.last.fm/music/Miss+Kittin" and
// "http://last.fm/music/Miss+Kittin/" both map to the same key.
// ------------------------------------------------------------
function normaliseLfmUrl(url) {
  if (!url) return null
  try {
    const u = new URL(url)
    return (u.hostname.replace(/^www\./, '') + u.pathname)
      .replace(/\/$/, '')
      .toLowerCase()
  } catch {
    return null
  }
}

// ------------------------------------------------------------
// Resolve similar_artist_id using the three lookup maps.
// Priority: LFM URL → MBID → name.
// ------------------------------------------------------------
function resolveSimilarArtistId(lfmUrl, mbid, name, lfmUrlToArtistId, mbidToArtistId, nameToArtistId) {
  const normUrl = normaliseLfmUrl(lfmUrl)
  if (normUrl) {
    const id = lfmUrlToArtistId.get(normUrl)
    if (id) return id
  }
  if (mbid) {
    const id = mbidToArtistId.get(mbid.toLowerCase())
    if (id) return id
  }
  if (name) {
    const id = nameToArtistId.get(name.toLowerCase().trim())
    if (id) return id
  }
  return null
}

// ------------------------------------------------------------
// Extract Last.fm artist name from a lastfm link row
// URL pattern: https://www.last.fm/music/Artist+Name
// handle may also be populated (it's the artist name)
// ------------------------------------------------------------
function lfmNameFromLink(link) {
  if (link.handle) return link.handle
  try {
    const parts = new URL(link.url).pathname.split('/')
    // pathname is like /music/Artist+Name — last non-empty segment
    const segment = parts.filter(Boolean).pop()
    return decodeURIComponent(segment.replace(/\+/g, ' '))
  } catch {
    return null
  }
}

// ------------------------------------------------------------
// DB helpers
// ------------------------------------------------------------
const PAGE_SIZE = 1000

async function fetchAllPages(buildQuery) {
  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await buildQuery(from)
    if (error) throw error
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return rows
}

// Keyset-paginated variant of fetchAllPages, for large or unindexed-filter
// sweeps where OFFSET .range() re-scans everything before each page and can
// hit a statement timeout. buildQuery receives the cursor (the last-seen value
// of `cursorCol`, or null on the first page) and must order by cursorCol
// ascending and apply .limit(PAGE_SIZE). Requires cursorCol to be selected and
// strictly increasing (a primary key is ideal).
async function fetchAllPagesKeyset(buildQuery, cursorCol = 'id') {
  const rows = []
  let cursor = null
  while (true) {
    const { data, error } = await buildQuery(cursor)
    if (error) throw error
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
    cursor = data[data.length - 1][cursorCol]
  }
  return rows
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(`fetch-lastfm-similar${DRY_RUN ? ' (DRY RUN)' : ''}${FORCE ? ' (--force)' : ''}`)
  console.log()

  // 1. Fetch all Last.fm links
  console.log('Fetching Last.fm links…')
  const lfmLinks = await fetchAllPages(from =>
    supabase
      .from('artist_links')
      .select('artist_id, url, handle')
      .eq('platform', 'lastfm')
      .order('artist_id')
      .range(from, from + PAGE_SIZE - 1)
  )
  console.log(`  Found ${lfmLinks.length} Last.fm link(s).`)

  // 2. Build lookup maps for resolving similar_artist_id
  console.log('Building artist lookup maps…')

  //    a) normalised Last.fm URL → artist_id (primary match key)
  const lfmUrlLinks = await fetchAllPages(from =>
    supabase
      .from('artist_links')
      .select('artist_id, url')
      .eq('platform', 'lastfm')
      .order('artist_id')
      .range(from, from + PAGE_SIZE - 1)
  )
  const lfmUrlToArtistId = new Map()
  for (const link of lfmUrlLinks) {
    const norm = normaliseLfmUrl(link.url)
    if (norm) lfmUrlToArtistId.set(norm, link.artist_id)
  }

  //    b) MBID → artist_id (from musicbrainz links)
  const mbLinks = await fetchAllPages(from =>
    supabase
      .from('artist_links')
      .select('artist_id, url, handle')
      .eq('platform', 'musicbrainz')
      .order('artist_id')
      .range(from, from + PAGE_SIZE - 1)
  )
  const mbidToArtistId = new Map()
  for (const link of mbLinks) {
    const mbid = link.handle || (link.url ? link.url.replace(/\/$/, '').split('/').pop() : null)
    if (mbid) mbidToArtistId.set(mbid.toLowerCase(), link.artist_id)
  }

  //    c) normalised name → artist_id (from artists table)
  const artistRows = await fetchAllPages(from =>
    supabase
      .from('artists')
      .select('id, name')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
  )
  const nameToArtistId = new Map()
  for (const a of artistRows) {
    nameToArtistId.set(a.name.toLowerCase().trim(), a.id)
  }
  const artistById = new Map(artistRows.map(a => [a.id, a]))

  // --resolve-only: backfill similar_artist_id for existing rows where it's null
  if (RESOLVE_ONLY) {
    console.log('\n--resolve-only: backfilling similar_artist_id for unmatched rows…')

    // Persist IDs that were tried but couldn't be resolved, so we skip them next run.
    // Cleared by --force.
    const TRIED_CACHE_FILE = path.join(CACHE_DIR, 'resolve_only_tried.json')
    let triedIds = new Set()
    if (!FORCE) {
      try {
        if (fs.existsSync(TRIED_CACHE_FILE)) {
          triedIds = new Set(JSON.parse(fs.readFileSync(TRIED_CACHE_FILE, 'utf-8')))
          console.log(`  Skipping ${triedIds.size} already-tried row(s) (use --force to retry all).`)
        }
      } catch { /* ignore corrupt cache */ }
    }

    // Keyset pagination: there is no index for `similar_artist_id IS NULL`
    // (idx_lastfm_similar_in_dir only covers IS NOT NULL), so an OFFSET sweep
    // walks the whole PK index and heap-filters every page — a timeout risk as
    // the table grows and unresolved rows get sparser.
    const allUnmatched = await fetchAllPagesKeyset(cursor => {
      let q = supabase
        .from('lastfm_similar_artists')
        .select('id, similar_artist_name, similar_artist_lfm_url, similar_artist_mbid')
        .is('similar_artist_id', null)
        .order('id')
        .limit(PAGE_SIZE)
      if (cursor !== null) q = q.gt('id', cursor)
      return q
    })
    const unmatched = allUnmatched.filter(r => !triedIds.has(r.id))
    console.log(`  Found ${allUnmatched.length} row(s) without similar_artist_id; ${unmatched.length} not yet tried.`)

    const BATCH_SIZE    = 500  // max row IDs per .in() filter
    const PROGRESS_STEP = Math.max(1, Math.floor(unmatched.length / 20)) // every ~5%

    let resolved = 0, failed = 0, processed = 0
    let nextProgressAt = PROGRESS_STEP
    // Map: similar_artist_id → [row.id, ...] — grouped so we can do one update per target
    let pendingByTarget = new Map()
    const newlyFailed = []   // IDs that couldn't be resolved this run
    const startTime = Date.now()

    async function flushBatch() {
      if (!pendingByTarget.size) return
      for (const [similarId, rowIds] of pendingByTarget) {
        // chunk in case many rows share the same target
        for (let i = 0; i < rowIds.length; i += BATCH_SIZE) {
          const chunk = rowIds.slice(i, i + BATCH_SIZE)
          const { error } = await supabase
            .from('lastfm_similar_artists')
            .update({ similar_artist_id: similarId })
            .in('id', chunk)
          if (error) {
            console.error(`  ✗ batch update error: ${error.message}`)
            failed += chunk.length
          } else {
            resolved += chunk.length
          }
        }
      }
      pendingByTarget = new Map()
    }

    for (const row of unmatched) {
      processed++

      const id = resolveSimilarArtistId(
        row.similar_artist_lfm_url, row.similar_artist_mbid, row.similar_artist_name,
        lfmUrlToArtistId, mbidToArtistId, nameToArtistId
      )

      if (id) {
        if (DEBUG) console.log(`  ✓ ${row.similar_artist_name} → ${id}`)
        if (!DRY_RUN) {
          if (!pendingByTarget.has(id)) pendingByTarget.set(id, [])
          pendingByTarget.get(id).push(row.id)
        } else {
          resolved++
        }
      } else {
        newlyFailed.push(row.id)
      }

      if (processed >= nextProgressAt) {
        if (!DRY_RUN) await flushBatch() // flush first so resolved count is accurate
        const pct     = ((processed / unmatched.length) * 100).toFixed(0)
        const elapsed = (Date.now() - startTime) / 1000
        const rate    = elapsed > 0 ? processed / elapsed : processed
        const remaining = Math.round((unmatched.length - processed) / rate)
        const eta     = remaining < 60
          ? `${remaining}s`
          : `${Math.floor(remaining / 60)}m ${remaining % 60}s`
        console.log(`  ${pct}%  ${processed}/${unmatched.length} processed — ${resolved} resolved — ETA ${eta}`)
        nextProgressAt += PROGRESS_STEP
      }
    }

    if (!DRY_RUN) {
      await flushBatch()
      // Persist newly-failed IDs so they're skipped next time
      for (const id of newlyFailed) triedIds.add(id)
      fs.writeFileSync(TRIED_CACHE_FILE, JSON.stringify([...triedIds]))
    }

    console.log(`\nResolved: ${resolved}  Failed: ${failed}  Still unmatched: ${allUnmatched.length - resolved - failed}`)
    console.log(`Cached ${newlyFailed.length} newly-unresolvable row(s) — will skip next run.`)
    if (DRY_RUN) console.log('Dry run — no data was written.')
    return
  }

  // 3. Build work list
  let workList = lfmLinks
    .map(link => {
      const lfmName = lfmNameFromLink(link)
      const artist  = artistById.get(link.artist_id) ?? { id: link.artist_id, name: '(unknown)' }
      return { artist, link, lfmName }
    })
    .filter(w => w.lfmName)

  if (OPT_NAME_FILTER) {
    workList = workList.filter(w =>
      w.artist.name.toLowerCase().includes(OPT_NAME_FILTER)
    )
    console.log(`  Name filter "${OPT_NAME_FILTER}": ${workList.length} match(es).`)
  }

  if (!FORCE) {
    const before = workList.length
    workList = workList.filter(w => !cacheRead(w.lfmName))
    const skipped = before - workList.length
    if (skipped) console.log(`  Skipping ${skipped} already-cached. Use --force to re-fetch.`)
  }

  if (OPT_LIMIT && workList.length > OPT_LIMIT) {
    for (let i = workList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [workList[i], workList[j]] = [workList[j], workList[i]]
    }
    workList = workList.slice(0, OPT_LIMIT)
    console.log(`  Sampling ${OPT_LIMIT} artist(s) randomly.`)
  }

  console.log(`\nProcessing ${workList.length} artist(s)…\n`)

  let totalSimilar = 0, totalMatched = 0, totalErrors = 0, done = 0

  for (const { artist, lfmName } of workList) {
    done++
    const pct = ((done / workList.length) * 100).toFixed(0)
    process.stdout.write(`  [${done}/${workList.length} ${pct}%] ${artist.name}… `)

    // Fetch from LFM (or cache)
    let data
    try {
      data = await lfmGetSimilar(lfmName)
    } catch (err) {
      console.log(`ERROR: ${err.message}`)
      totalErrors++
      continue
    }

    const similarArtists = data?.similarartists?.artist ?? []

    if (DEBUG) {
      console.log()
      console.log(`    LFM returned ${similarArtists.length} similar artist(s)`)
    }

    // Build rows to upsert
    const rows = similarArtists.map((s, i) => {
      const mbid = s.mbid && s.mbid.trim() ? s.mbid.trim().toLowerCase() : null
      const lfmUrl = s.url || null

      const similarArtistId = resolveSimilarArtistId(
        lfmUrl, mbid, s.name,
        lfmUrlToArtistId, mbidToArtistId, nameToArtistId
      )

      if (DEBUG && similarArtistId) {
        console.log(`    ✓ matched: ${s.name} → ${similarArtistId}`)
      }

      return {
        artist_id:               artist.id,
        similar_artist_name:     s.name,
        similar_artist_lfm_url:  lfmUrl,
        similar_artist_mbid:     mbid,
        match_score:             parseFloat(s.match),
        rank:                    i + 1,
        similar_artist_id:       similarArtistId ?? undefined,
        fetched_at:              new Date().toISOString(),
      }
    })

    const matched = rows.filter(r => r.similar_artist_id).length
    totalSimilar += rows.length
    totalMatched += matched

    if (!DRY_RUN && rows.length) {
      const { error } = await supabase
        .from('lastfm_similar_artists')
        .upsert(rows, { onConflict: 'artist_id,similar_artist_name' })
      if (error) {
        console.log(`ERROR (upsert): ${error.message}`)
        totalErrors++
        continue
      }
    }

    console.log(`${rows.length} similar, ${matched} in directory`)
  }

  console.log()
  console.log('─'.repeat(50))
  console.log(`Artists processed       : ${workList.length}`)
  console.log(`Total similar artists   : ${totalSimilar}`)
  console.log(`Matched to directory    : ${totalMatched}`)
  console.log(`Errors                  : ${totalErrors}`)
  if (DRY_RUN) console.log('\nDry run — no data was written.')
}

main().catch(err => {
  console.error('\nFailed:', err?.message ?? err)
  process.exit(1)
})
