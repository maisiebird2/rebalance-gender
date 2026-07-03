#!/usr/bin/env node
// ============================================================
// harvest-genres-lastfm.mjs
//
// For every artist in the database that has a Last.fm link
// (platform = 'lastfm' in artist_links), calls
// artist.getTopTags and writes the results into the
// artist_harvested_genres staging table.
//
// tag_count stores the Last.fm "count" field (0–100), which is
// a weighting reflecting how many listeners have applied that
// tag relative to the most-applied tag for that artist.
//
// Rate limit: Last.fm allows ~4 req/s. A 250 ms delay between
// requests is used (same as fetch-lastfm-similar.mjs). A full
// run over ~1,400 artists with LFM links takes ~6–8 minutes,
// though many artists will have no LFM link and be skipped.
//
// API results are cached to .cache/lastfm_genres/<encoded-name>.json.
// Re-runs skip cached artists unless --force is passed.
//
// Usage (from rebalance-gender/):
//
//   node scripts/harvest-genres-lastfm.mjs
//   node scripts/harvest-genres-lastfm.mjs --limit=20
//   node scripts/harvest-genres-lastfm.mjs --force
//   node scripts/harvest-genres-lastfm.mjs --name="bicep"
//   node scripts/harvest-genres-lastfm.mjs --min-count=5
//   node scripts/harvest-genres-lastfm.mjs --debug
//   DRY_RUN=1 node scripts/harvest-genres-lastfm.mjs
//
// Requires LASTFM_API_KEY and (NEXT_PUBLIC_SUPABASE_URL +
// SUPABASE_SECRET_KEY) in .env.local.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ------------------------------------------------------------
// CLI / env
// ------------------------------------------------------------
const args    = process.argv.slice(2)
const DRY_RUN = process.env.DRY_RUN === '1' || args.includes('--dry-run')
const FORCE   = args.includes('--force')
const DEBUG   = args.includes('--debug')

const limitArg    = args.find(a => a.startsWith('--limit='))
const nameArg     = args.find(a => a.startsWith('--name='))
const minCountArg = args.find(a => a.startsWith('--min-count='))

const OPT_LIMIT     = limitArg    ? parseInt(limitArg.split('=')[1], 10)  : null
const OPT_NAME      = nameArg     ? nameArg.split('=').slice(1).join('=').toLowerCase() : null
const OPT_MIN_COUNT = minCountArg ? parseInt(minCountArg.split('=')[1], 10) : 1

const LFM_RATE_MS = 250   // 4 req/s

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
if (!LASTFM_API_KEY) {
  console.error('Missing LASTFM_API_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
})

// ------------------------------------------------------------
// Disk cache
// ------------------------------------------------------------
const CACHE_DIR = path.join(__dirname, '..', '.cache', 'lastfm_genres')
fs.mkdirSync(CACHE_DIR, { recursive: true })

function cacheKey(lfmUrl) {
  // Use the URL itself as the cache key (URL-encoded as a filename).
  return path.join(CACHE_DIR, encodeURIComponent(lfmUrl) + '.json')
}

function cacheRead(lfmUrl) {
  const fp = cacheKey(lfmUrl)
  if (!fs.existsSync(fp)) return null
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')) } catch { return null }
}

function cacheWrite(lfmUrl, data) {
  fs.writeFileSync(cacheKey(lfmUrl), JSON.stringify(data))
}

// ------------------------------------------------------------
// Last.fm API
// ------------------------------------------------------------
const LFM_BASE = 'https://ws.audioscrobbler.com/2.0/'

let lastLfmRequest = 0

async function lfmGetTopTags(lfmUrl) {
  if (!FORCE) {
    const cached = cacheRead(lfmUrl)
    if (cached) return cached
  }

  // Rate limit
  const now  = Date.now()
  const wait = LFM_RATE_MS - (now - lastLfmRequest)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastLfmRequest = Date.now()

  // Extract artist name or mbid from the LFM URL.
  // Last.fm URLs look like https://www.last.fm/music/Artist+Name
  // We can pass either mbid (more reliable) or artist name to the API.
  const artistSlug = lfmUrl.replace(/\/$/, '').split('/music/').pop()
  const artistName = decodeURIComponent(artistSlug.replace(/\+/g, ' '))

  const params = new URLSearchParams({
    method:  'artist.getTopTags',
    artist:  artistName,
    api_key: LASTFM_API_KEY,
    format:  'json',
    autocorrect: '1',
  })

  const url = `${LFM_BASE}?${params}`
  if (DEBUG) console.log(`  → GET ${url.replace(LASTFM_API_KEY, '<key>')}`)

  const res = await fetch(url, {
    headers: { 'User-Agent': 'WomenInElectronicMusicDirectory/1.0 (maisiemeson@gmail.com)' },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Last.fm ${res.status}: ${body.slice(0, 120)}`)
  }

  const data = await res.json()

  // LFM returns {"error": 6, "message": "Artist not found"} for unknowns.
  if (data.error) {
    if (data.error === 6) return null  // artist not found — not a hard error
    throw new Error(`Last.fm API error ${data.error}: ${data.message}`)
  }

  cacheWrite(lfmUrl, data)
  return data
}

// ------------------------------------------------------------
// Pagination helper
// ------------------------------------------------------------
const PAGE_SIZE = 1000

async function fetchAllPages(buildQuery) {
  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1)
    if (error) throw error
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return rows
}

function chunk(array, size) {
  const out = []
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size))
  return out
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(`harvest-genres-lastfm${DRY_RUN ? ' (DRY RUN)' : ''}${FORCE ? ' (--force)' : ''}`)
  console.log()

  // 1. Load all artist_links rows where platform = 'lastfm'.
  console.log('Fetching Last.fm links from artist_links…')
  const links = await fetchAllPages((from, to) => {
    let q = supabase
      .from('artist_links')
      .select(OPT_NAME
        ? 'artist_id, url, artists!inner(name)'
        : 'artist_id, url')
      .eq('platform', 'lastfm')
      .not('url', 'is', null)
      .order('artist_id')
      .range(from, to)
    if (OPT_NAME) q = q.ilike('artists.name', `%${OPT_NAME}%`)
    return q
  })
  console.log(`  Found ${links.length} Last.fm link(s).`)

  if (links.length === 0) {
    console.log('\nNo Last.fm links found. Nothing to harvest.')
    return
  }

  // 2. Fetch artist names for display.
  // .in() with hundreds of IDs overflows the REST API URL limit — chunk it.
  const artistIds = [...new Set(links.map(l => l.artist_id))]
  const artistRows = []
  for (const idChunk of chunk(artistIds, 200)) {
    const { data, error } = await supabase
      .from('artists')
      .select('id, name')
      .in('id', idChunk)
    if (error) throw error
    artistRows.push(...data)
  }
  const artistById = new Map(artistRows.map(a => [a.id, a.name]))

  // 3. Build work list, skipping cached entries unless --force.
  let workList = links.map(link => ({
    artistId:   link.artist_id,
    artistName: link.artists?.name ?? artistById.get(link.artist_id) ?? '(unknown)',
    lfmUrl:     link.url,
  }))

  if (!FORCE) {
    const before = workList.length
    workList = workList.filter(w => !cacheRead(w.lfmUrl))
    const skipped = before - workList.length
    if (skipped) console.log(`  Skipping ${skipped} already-cached artist(s). Use --force to re-fetch.`)
  }

  if (OPT_LIMIT && workList.length > OPT_LIMIT) {
    workList = workList.slice(0, OPT_LIMIT)
    console.log(`  Applying --limit: processing ${OPT_LIMIT} artist(s).`)
  }

  console.log(`\nProcessing ${workList.length} artist(s)…`)
  console.log(`  Rate: ~4 req/s  |  Est. time: ~${Math.ceil(workList.length * LFM_RATE_MS / 60000)} min\n`)

  let totalTags   = 0
  let totalErrors = 0
  let notFound    = 0
  const toInsert  = []

  for (let i = 0; i < workList.length; i++) {
    const { artistId, artistName, lfmUrl } = workList[i]
    const pct = (((i + 1) / workList.length) * 100).toFixed(0)
    process.stdout.write(`  [${i + 1}/${workList.length} ${pct}%] ${artistName}… `)

    let data
    try {
      data = await lfmGetTopTags(lfmUrl)
    } catch (err) {
      console.log(`ERROR: ${err.message}`)
      totalErrors++
      continue
    }

    if (!data) {
      console.log('not found on Last.fm')
      notFound++
      continue
    }

    const rawTags = Array.isArray(data?.toptags?.tag) ? data.toptags.tag
      : data?.toptags?.tag ? [data.toptags.tag]   // single tag comes as object, not array
      : []

    const tags = rawTags
      .filter(t => (t.count ?? 0) >= OPT_MIN_COUNT)
      .map(t => ({ tag: t.name.toLowerCase().trim(), count: parseInt(t.count, 10) }))
      .filter(t => t.tag)

    if (DEBUG) {
      console.log(`${tags.length} tag(s): ${tags.slice(0, 6).map(t => `${t.tag}(${t.count})`).join(', ')}`)
    } else {
      console.log(`${tags.length} tag(s)`)
    }

    for (const { tag, count } of tags) {
      toInsert.push({
        artist_id:       artistId,
        source_platform: 'lastfm',
        raw_tag:         tag,
        tag_count:       count,
      })
    }
    totalTags += tags.length
  }

  console.log()
  console.log(`Tags collected: ${totalTags}`)
  console.log(`Artists not found on Last.fm: ${notFound}`)
  console.log(`Errors: ${totalErrors}`)

  if (DRY_RUN || toInsert.length === 0) {
    if (DRY_RUN) console.log('\nDry run — no data written.')
    return
  }

  // 4. Upsert into artist_harvested_genres.
  // ON CONFLICT DO NOTHING: re-runs won't overwrite existing rows
  // (including any genre_id/skipped already set by the integration script).
  console.log(`\nWriting ${toInsert.length} row(s) to artist_harvested_genres…`)
  let inserted = 0
  let errors   = 0
  for (const batch of chunk(toInsert, 500)) {
    const { error } = await supabase
      .from('artist_harvested_genres')
      .upsert(batch, { onConflict: 'artist_id,source_platform,raw_tag', ignoreDuplicates: true })
    if (error) {
      console.error(`  Batch upsert failed: ${error.message}`)
      errors++
    } else {
      inserted += batch.length
    }
  }

  console.log()
  console.log('─'.repeat(50))
  console.log(`Rows written  : ${inserted}`)
  console.log(`Batch errors  : ${errors}`)
}

main().catch(err => {
  console.error('\nFailed:', err?.message ?? err)
  process.exit(1)
})
