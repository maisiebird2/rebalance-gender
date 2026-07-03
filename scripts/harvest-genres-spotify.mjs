#!/usr/bin/env node
// ============================================================
// harvest-genres-spotify.mjs
//
// For every artist in the database that has a Spotify link
// (platform = 'spotify' in artist_links), calls
// GET /artists/{id} and writes the returned genre array into
// the artist_harvested_genres staging table.
//
// Spotify's genre field on artist objects is a free-text array
// (e.g. ["techno", "minimal techno", "electronic"]) curated by
// Spotify's editorial team. No count/weight is returned.
//
// Auth: OAuth 2 Client Credentials (no per-user login required,
// all data is public). Mirrors the pattern in
// resolve-and-load-links-lf-mb-sp.mjs.
//
// Rate limit: Spotify's public API allows ~30 req/s for client
// credentials flows, so a 50 ms delay is used. A full run over
// ~1,400 artists takes roughly 2–3 minutes.
//
// API results are cached to .cache/spotify_genres/<spotify-id>.json.
// Re-runs skip cached artists unless --force is passed.
//
// Usage (from rebalance-gender/):
//
//   node scripts/harvest-genres-spotify.mjs
//   node scripts/harvest-genres-spotify.mjs --limit=20
//   node scripts/harvest-genres-spotify.mjs --force
//   node scripts/harvest-genres-spotify.mjs --name="bicep"
//   node scripts/harvest-genres-spotify.mjs --debug
//   DRY_RUN=1 node scripts/harvest-genres-spotify.mjs
//
// Requires SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET,
// NEXT_PUBLIC_SUPABASE_URL, and SUPABASE_SECRET_KEY in .env.local.
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

const limitArg = args.find(a => a.startsWith('--limit='))
const nameArg  = args.find(a => a.startsWith('--name='))

const OPT_LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null
const OPT_NAME  = nameArg  ? nameArg.split('=').slice(1).join('=').toLowerCase() : null

const SPOTIFY_RATE_MS = 50    // ~20 req/s, well within Spotify's limits

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

const SUPABASE_URL        = process.env.NEXT_PUBLIC_SUPABASE_URL
const SECRET_KEY          = process.env.SUPABASE_SECRET_KEY
const SPOTIFY_CLIENT_ID   = process.env.SPOTIFY_CLIENT_ID
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local')
  process.exit(1)
}
if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error('Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
})

// ------------------------------------------------------------
// Disk cache
// ------------------------------------------------------------
const CACHE_DIR = path.join(__dirname, '..', '.cache', 'spotify_genres')
fs.mkdirSync(CACHE_DIR, { recursive: true })

function cacheRead(spotifyId) {
  const fp = path.join(CACHE_DIR, `${spotifyId}.json`)
  if (!fs.existsSync(fp)) return null
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')) } catch { return null }
}

function cacheWrite(spotifyId, data) {
  fs.writeFileSync(path.join(CACHE_DIR, `${spotifyId}.json`), JSON.stringify(data))
}

// ------------------------------------------------------------
// Spotify OAuth (Client Credentials)
// ------------------------------------------------------------
let _spotifyToken  = null
let _spotifyExpiry = 0

async function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyExpiry) return _spotifyToken

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:  'Basic ' + Buffer.from(
        `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
      ).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Spotify auth failed HTTP ${res.status}: ${body.slice(0, 120)}`)
  }
  const data = await res.json()
  _spotifyToken  = data.access_token
  _spotifyExpiry = Date.now() + (data.expires_in - 60) * 1000
  return _spotifyToken
}

// ------------------------------------------------------------
// Extract Spotify artist ID from a Spotify URL.
// Handles both open.spotify.com/artist/<id> and spotify:<type>:<id>.
// ------------------------------------------------------------
function spotifyIdFromUrl(url) {
  if (!url) return null
  // URI format: spotify:artist:abc123
  const uriMatch = url.match(/^spotify:artist:([A-Za-z0-9]+)$/)
  if (uriMatch) return uriMatch[1]
  // URL format: https://open.spotify.com/artist/abc123[?...]
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/')
    const idx = parts.indexOf('artist')
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1]
  } catch { /* fall through */ }
  return null
}

// ------------------------------------------------------------
// Fetch artist genres from Spotify
// ------------------------------------------------------------
let lastSpotifyRequest = 0

async function fetchSpotifyArtist(spotifyId) {
  if (!FORCE) {
    const cached = cacheRead(spotifyId)
    if (cached) return cached
  }

  // Rate limit
  const now  = Date.now()
  const wait = SPOTIFY_RATE_MS - (now - lastSpotifyRequest)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastSpotifyRequest = Date.now()

  const token = await getSpotifyToken()
  const url   = `https://api.spotify.com/v1/artists/${spotifyId}`

  if (DEBUG) console.log(`  → GET ${url}`)

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  // Token expired mid-run — refresh once and retry.
  if (res.status === 401) {
    _spotifyToken = null
    return fetchSpotifyArtist(spotifyId)
  }

  if (res.status === 404) return null   // artist not found on Spotify

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Spotify HTTP ${res.status}: ${body.slice(0, 120)}`)
  }

  const data = await res.json()
  cacheWrite(spotifyId, data)
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
  console.log(`harvest-genres-spotify${DRY_RUN ? ' (DRY RUN)' : ''}${FORCE ? ' (--force)' : ''}`)
  console.log()

  // 1. Load all Spotify links.
  console.log('Fetching Spotify links from artist_links…')
  const links = await fetchAllPages((from, to) => {
    let q = supabase
      .from('artist_links')
      .select(OPT_NAME
        ? 'artist_id, url, handle, artists!inner(name)'
        : 'artist_id, url, handle')
      .eq('platform', 'spotify')
      .not('url', 'is', null)
      .order('artist_id')
      .range(from, to)
    if (OPT_NAME) q = q.ilike('artists.name', `%${OPT_NAME}%`)
    return q
  })
  console.log(`  Found ${links.length} Spotify link(s).`)

  if (links.length === 0) {
    console.log('\nNo Spotify links found. Nothing to harvest.')
    return
  }

  // 2. Fetch artist names for display.
  const artistIds = [...new Set(links.map(l => l.artist_id))]
  const artistRows = await fetchAllPages((from, to) =>
    supabase.from('artists').select('id, name').in('id', artistIds).range(from, to)
  )
  const artistById = new Map(artistRows.map(a => [a.id, a.name]))

  // 3. Build work list.
  let workList = links
    .map(link => {
      const spotifyId = link.handle || spotifyIdFromUrl(link.url)
      if (!spotifyId) return null
      return {
        artistId:   link.artist_id,
        artistName: link.artists?.name ?? artistById.get(link.artist_id) ?? '(unknown)',
        spotifyId,
      }
    })
    .filter(Boolean)

  const noId = links.length - workList.length
  if (noId > 0) console.log(`  Skipping ${noId} link(s) where Spotify ID could not be extracted.`)

  if (!FORCE) {
    const before = workList.length
    workList = workList.filter(w => !cacheRead(w.spotifyId))
    const skipped = before - workList.length
    if (skipped) console.log(`  Skipping ${skipped} already-cached artist(s). Use --force to re-fetch.`)
  }

  if (OPT_LIMIT && workList.length > OPT_LIMIT) {
    workList = workList.slice(0, OPT_LIMIT)
    console.log(`  Applying --limit: processing ${OPT_LIMIT} artist(s).`)
  }

  console.log(`\nProcessing ${workList.length} artist(s)…`)
  console.log(`  Rate: ~20 req/s  |  Est. time: ~${Math.ceil(workList.length * SPOTIFY_RATE_MS / 60000)} min\n`)

  // Ensure token is valid before starting the loop.
  await getSpotifyToken()

  let totalTags   = 0
  let totalErrors = 0
  let notFound    = 0
  const toInsert  = []

  for (let i = 0; i < workList.length; i++) {
    const { artistId, artistName, spotifyId } = workList[i]
    const pct = (((i + 1) / workList.length) * 100).toFixed(0)
    process.stdout.write(`  [${i + 1}/${workList.length} ${pct}%] ${artistName}… `)

    let data
    try {
      data = await fetchSpotifyArtist(spotifyId)
    } catch (err) {
      console.log(`ERROR: ${err.message}`)
      totalErrors++
      continue
    }

    if (!data) {
      console.log('not found on Spotify')
      notFound++
      continue
    }

    const genres = Array.isArray(data.genres) ? data.genres : []
    const tags = genres
      .map(g => g.toLowerCase().trim())
      .filter(Boolean)

    if (DEBUG) {
      console.log(`${tags.length} genre(s): ${tags.slice(0, 6).join(', ')}`)
    } else {
      console.log(`${tags.length} genre(s)`)
    }

    for (const tag of tags) {
      toInsert.push({
        artist_id:       artistId,
        source_platform: 'spotify',
        raw_tag:         tag,
        tag_count:       null,   // Spotify doesn't provide a weight per genre
      })
    }
    totalTags += tags.length
  }

  console.log()
  console.log(`Tags collected: ${totalTags}`)
  console.log(`Artists not found on Spotify: ${notFound}`)
  console.log(`Errors: ${totalErrors}`)

  if (DRY_RUN || toInsert.length === 0) {
    if (DRY_RUN) console.log('\nDry run — no data written.')
    return
  }

  // 4. Upsert into artist_harvested_genres.
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
