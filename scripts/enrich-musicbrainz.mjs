#!/usr/bin/env node
// ============================================================
// enrich-musicbrainz.mjs
//
// For every artist in the database that has a resolved
// MusicBrainz link (platform = 'musicbrainz' in artist_links),
// fetches from the MusicBrainz API:
//
//   - Folksonomy tags  → upserted into mb_tags
//   - Artist relations (collaborations, band membership, etc.)
//     → upserted into `collaborations` (source_platform =
//     'musicbrainz'), but ONLY when the related artist's MBID is
//     also in our artists table
//
// MusicBrainz enforces a strict 1 request/second rate limit.
// A full run over ~1,400 artists takes roughly 25–30 minutes.
//
// Usage (from rebalance-gender/):
//
//   node scripts/enrich-musicbrainz.mjs
//   node scripts/enrich-musicbrainz.mjs --limit=20
//   node scripts/enrich-musicbrainz.mjs --force
//   node scripts/enrich-musicbrainz.mjs --name="nina kraviz"
//   node scripts/enrich-musicbrainz.mjs --debug
//   DRY_RUN=1 node scripts/enrich-musicbrainz.mjs
//
// The script caches raw API responses to .cache/mb_enrich/<mbid>.json.
// Re-runs skip cached artists unless --force is passed.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalizeResidentAdvisorUrl, resolveProfileLinkUrl } from '../src/lib/profile-links.js'
import { cleanLinkUrl } from '../src/lib/platforms.js'
import { classifyPlatformUrl, CLASSIFY_CONFIGS } from '../src/lib/classify-platform-url.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ------------------------------------------------------------
// CLI / env
// ------------------------------------------------------------
const args = process.argv.slice(2)

const DRY_RUN = process.env.DRY_RUN === '1' || args.includes('--dry-run')
const FORCE   = args.includes('--force')
const DEBUG   = args.includes('--debug')

const limitArg      = args.find(a => a.startsWith('--limit='))
const nameFilterArg = args.find(a => a.startsWith('--name='))
const minTagArg     = args.find(a => a.startsWith('--min-tag-count='))

const OPT_LIMIT         = limitArg      ? parseInt(limitArg.split('=')[1], 10)  : null
const OPT_NAME_FILTER   = nameFilterArg ? nameFilterArg.split('=').slice(1).join('=').toLowerCase() : null
const OPT_MIN_TAG_COUNT = minTagArg     ? parseInt(minTagArg.split('=')[1], 10) : 1

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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SECRET_KEY   = process.env.SUPABASE_SECRET_KEY
if (!SUPABASE_URL || !SECRET_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false },
})

// ------------------------------------------------------------
// Disk cache
// v2: cache dir bumped so existing v1 files (fetched without url-rels)
// are not reused — they're missing the URL-relation data we now need.
// Old .cache/mb_enrich files can be deleted once a fresh run completes.
// ------------------------------------------------------------
const CACHE_DIR = path.join(__dirname, '..', '.cache', 'mb_enrich_v2')
fs.mkdirSync(CACHE_DIR, { recursive: true })

function cacheKey(mbid) {
  return path.join(CACHE_DIR, `${mbid}.json`)
}

function cacheRead(mbid) {
  const fp = cacheKey(mbid)
  if (!fs.existsSync(fp)) return null
  try { return JSON.parse(fs.readFileSync(fp, 'utf-8')) } catch { return null }
}

function cacheWrite(mbid, data) {
  fs.writeFileSync(cacheKey(mbid), JSON.stringify(data))
}

// ------------------------------------------------------------
// MusicBrainz API
// ------------------------------------------------------------
const MB_BASE      = 'https://musicbrainz.org/ws/2'
const MB_USER_AGENT = 'WomenInElectronicMusicDirectory/1.0 (maisiemeson@gmail.com)'
const MB_RATE_MS   = 1100   // strict 1 req/s; add 100ms headroom

let lastMbRequest = 0

async function mbFetch(mbid) {
  // Check cache first (unless --force)
  if (!FORCE) {
    const cached = cacheRead(mbid)
    if (cached) return cached
  }

  // Rate limit
  const now = Date.now()
  const wait = MB_RATE_MS - (now - lastMbRequest)
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  lastMbRequest = Date.now()

  const url = `${MB_BASE}/artist/${mbid}?inc=tags+artist-rels+url-rels&fmt=json`
  if (DEBUG) console.log(`  → GET ${url}`)

  const res = await fetch(url, {
    headers: { 'User-Agent': MB_USER_AGENT, 'Accept': 'application/json' },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`MusicBrainz ${res.status}: ${body.slice(0, 120)}`)
  }

  const data = await res.json()
  cacheWrite(mbid, data)
  return data
}

// ------------------------------------------------------------
// Relation type inclusion set
// ------------------------------------------------------------
// Only artist-to-artist relation types that are meaningful
// signals for musical similarity. Update this list if you want
// to broaden or narrow the signals captured.
const COLLAB_RELATION_TYPES = new Set([
  'collaboration',
  'member of band',
  'supporting musician',
  'instrumental supporting musician',
  'vocal supporting musician',
  'remixer',
  'conductor',
  'performer',
  'guest performer',
  'tour member',
])

// ------------------------------------------------------------
// URL-rel classification.
//
// The domain → platform key table lives in
// src/lib/classify-platform-url.ts, shared with the web forms and every
// other harvester, so a newly tracked platform is added in one place.
// CLASSIFY_CONFIGS.musicbrainz carries this script's own deviations:
// skip musicbrainz.org (self-reference) and wikidata.org (not a platform
// we track). Twitter/X is skipped centrally by project policy.
//
// "free streaming" type rels are excluded entirely before this runs.
// ------------------------------------------------------------

/**
 * Returns the platform key for a URL, 'other' for unmapped-but-valid
 * domains, or null for domains we want to skip entirely.
 */
function platformFromUrl(urlStr) {
  return classifyPlatformUrl(urlStr, CLASSIFY_CONFIGS.musicbrainz)
}

// ------------------------------------------------------------
// Extract MBID from a musicbrainz link URL
// (e.g. "https://musicbrainz.org/artist/abc-123" → "abc-123")
// ------------------------------------------------------------
function mbidFromUrl(url) {
  if (!url) return null
  return url.replace(/\/$/, '').split('/').pop()
}

// ------------------------------------------------------------
// DB helpers
// ------------------------------------------------------------
const PAGE_SIZE = 1000

async function fetchAllPages(query) {
  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return rows
}

// Upsert mb_tags rows; ignore conflicts (tag already exists for artist).
async function upsertTags(artistId, tags) {
  if (!tags.length) return { inserted: 0, skipped: 0 }
  const rows = tags.map(t => ({ artist_id: artistId, tag: t }))
  const { error } = await supabase
    .from('mb_tags')
    .upsert(rows, { onConflict: 'artist_id,tag', ignoreDuplicates: true })
  if (error) throw error
  return { inserted: rows.length }
}

// Upsert a collaboration edge into the platform-neutral `collaborations`
// table (source_platform = 'musicbrainz'; sync-discogs.mjs writes the
// same table with source_platform = 'discogs').
// IMPORTANT: artist_id_a < artist_id_b (UUID string comparison) per schema constraint.
async function upsertCollab(idA, idB, count) {
  const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA]

  // Try insert first; if conflict, increment the count.
  const { error: insertErr } = await supabase
    .from('collaborations')
    .insert({ artist_id_a: lo, artist_id_b: hi, collab_count: count, source_platform: 'musicbrainz' })
    .select()

  if (!insertErr) return 'inserted'

  // Conflict on unique (artist_id_a, artist_id_b, source_platform) — increment collab_count
  if (insertErr.code === '23505') {
    const { data: existing, error: selectErr } = await supabase
      .from('collaborations')
      .select('id, collab_count')
      .eq('artist_id_a', lo)
      .eq('artist_id_b', hi)
      .eq('source_platform', 'musicbrainz')
      .single()
    if (selectErr) throw selectErr

    const { error: updateErr } = await supabase
      .from('collaborations')
      .update({ collab_count: existing.collab_count + count })
      .eq('id', existing.id)
    if (updateErr) throw updateErr
    return 'updated'
  }

  throw insertErr
}

// Update artists.gender_mb from MusicBrainz data.
// Only writes when MB returns a non-null value; never clears an
// existing value with null.
async function updateGender(artistId, gender) {
  if (!gender) return false
  const { error } = await supabase
    .from('artists')
    .update({ gender_mb: gender })
    .eq('id', artistId)
  if (error) throw error
  return true
}

// Upsert artist_links rows harvested from MB url-rels.
// Conflicts on (artist_id, platform, url) are silently ignored so
// we never overwrite or duplicate an existing link.
async function upsertArtistLinks(rows) {
  if (!rows.length) return
  const { error } = await supabase
    .from('artist_links')
    .upsert(rows, { onConflict: 'artist_id,platform', ignoreDuplicates: true })
  if (error) throw error
}

// ------------------------------------------------------------
// Process a single artist
// ------------------------------------------------------------
async function processArtist(artist, mbid, mbidToArtistId) {
  const label = `[${artist.name}]`

  // Fetch from MB (or cache)
  let mbData
  try {
    mbData = await mbFetch(mbid)
  } catch (err) {
    console.error(`  ${label} MB fetch failed: ${err.message}`)
    return { tags: 0, collabs: 0, links: 0, gender: false, errors: 1 }
  }

  // ---- Tags ----
  const rawTags = Array.isArray(mbData.tags) ? mbData.tags : []
  const tags = rawTags
    .filter(t => (t.count ?? 0) >= OPT_MIN_TAG_COUNT)
    .map(t => t.name.toLowerCase().trim())
    .filter(Boolean)

  if (DEBUG) console.log(`  ${label} tags (${tags.length}): ${tags.slice(0, 8).join(', ')}`)

  let tagCount = 0
  if (!DRY_RUN && tags.length) {
    const { inserted } = await upsertTags(artist.id, tags)
    tagCount = inserted
  } else {
    tagCount = tags.length
  }

  // ---- Collaborations ----
  const rawRelations = Array.isArray(mbData.relations) ? mbData.relations : []

  // Count distinct relation types per related MBID (handles multiple
  // relation types between the same pair, e.g. "member of band" + "remixer")
  const relatedMbids = new Map()   // mbid → count

  for (const rel of rawRelations) {
    if (rel['target-type'] !== 'artist') continue
    const type = (rel.type ?? '').toLowerCase()
    if (!COLLAB_RELATION_TYPES.has(type)) continue

    const relatedMbid = rel.artist?.id
    if (!relatedMbid) continue
    if (relatedMbid === mbid) continue   // skip self-loops

    relatedMbids.set(relatedMbid, (relatedMbids.get(relatedMbid) ?? 0) + 1)
  }

  if (DEBUG) {
    const known = [...relatedMbids.keys()].filter(m => mbidToArtistId.has(m))
    console.log(`  ${label} relations total=${relatedMbids.size} in-directory=${known.length}`)
  }

  let collabCount = 0
  for (const [relMbid, count] of relatedMbids) {
    const relArtistId = mbidToArtistId.get(relMbid)
    if (!relArtistId) continue   // not in our database — skip

    if (!DRY_RUN) {
      try {
        await upsertCollab(artist.id, relArtistId, count)
      } catch (err) {
        console.error(`  ${label} collab upsert failed: ${err.message}`)
      }
    }
    collabCount++
  }

  // ---- Gender ----
  // MB returns e.g. "Female", "Male", "Non-binary", or null.
  const mbGender = mbData.gender ?? null
  let genderUpdated = false
  if (mbGender) {
    if (DEBUG) console.log(`  ${label} gender: ${mbGender}`)
    if (!DRY_RUN) {
      try {
        genderUpdated = await updateGender(artist.id, mbGender)
      } catch (err) {
        console.error(`  ${label} gender update failed: ${err.message}`)
      }
    } else {
      genderUpdated = true
    }
  }

  // ---- External links (url-rels) ----
  const urlRels = rawRelations.filter(r => r['target-type'] === 'url')
  const linkRows = []
  let otherAdded = false

  for (const rel of urlRels) {
    if ((rel.type ?? '').toLowerCase() === 'free streaming') continue
    const rawResource = rel.url?.resource
    if (!rawResource) continue

    // Rewrite pre-rebrand residentadvisor.net links onto ra.co before both
    // platform detection and storage.
    const resource = canonicalizeResidentAdvisorUrl(rawResource)

    const platform = platformFromUrl(resource)
    if (!platform) continue        // null = skip entirely

    if (platform === 'other') {
      if (otherAdded) continue     // only keep the first unmatched URL
      otherAdded = true
    }

    linkRows.push({
      artist_id: artist.id,
      platform,
      // Canonicalize exactly as the submit/edit forms do — strips tracking
      // params and trims sub-pages (YouTube /watch + /@handle tabs, Beatport
      // /artist/<slug>/<id>/tracks, …) via the shared cleaner.
      url: resolveProfileLinkUrl(platform, resource, cleanLinkUrl),
      handle: null,
      not_found: false,
    })
  }

  if (DEBUG) console.log(`  ${label} url-rels: ${linkRows.length} link(s) to upsert`)

  let linkCount = 0
  if (!DRY_RUN && linkRows.length) {
    try {
      await upsertArtistLinks(linkRows)
      linkCount = linkRows.length
    } catch (err) {
      console.error(`  ${label} link upsert failed: ${err.message}`)
    }
  } else {
    linkCount = linkRows.length
  }

  return { tags: tagCount, collabs: collabCount, links: linkCount, gender: genderUpdated, errors: 0 }
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(`enrich-musicbrainz${DRY_RUN ? ' (DRY RUN)' : ''}${FORCE ? ' (--force)' : ''}`)
  console.log()

  // 1. Fetch all artist_links where platform = 'musicbrainz'
  console.log('Fetching MusicBrainz links from artist_links…')
  const allLinks = await fetchAllPages(
    supabase
      .from('artist_links')
      .select('artist_id, url, handle')
      .eq('platform', 'musicbrainz')
      .order('artist_id')
  )
  console.log(`  Found ${allLinks.length} MusicBrainz link(s).`)

  // Build MBID → artist_id map (for collaboration resolution)
  const mbidToArtistId = new Map()
  for (const link of allLinks) {
    const mbid = link.handle || mbidFromUrl(link.url)
    if (mbid) mbidToArtistId.set(mbid, link.artist_id)
  }

  // 2. Fetch artist names for display
  console.log('Fetching artist names…')
  const artistRows = await fetchAllPages(
    supabase
      .from('artists')
      .select('id, name')
      .order('id')
  )
  const artistById = new Map(artistRows.map(a => [a.id, a]))

  // 3. Build the work list: one entry per MB link
  let workList = allLinks
    .map(link => {
      const mbid = link.handle || mbidFromUrl(link.url)
      const artist = artistById.get(link.artist_id) ?? { id: link.artist_id, name: '(unknown)' }
      return { artist, mbid }
    })
    .filter(w => w.mbid)

  // Optional name filter
  if (OPT_NAME_FILTER) {
    workList = workList.filter(w => w.artist.name.toLowerCase().includes(OPT_NAME_FILTER))
    console.log(`  Name filter "${OPT_NAME_FILTER}": ${workList.length} match(es).`)
  }

  // Skip already-processed artists unless --force
  if (!FORCE) {
    const before = workList.length
    workList = workList.filter(w => !cacheRead(w.mbid))
    const skipped = before - workList.length
    if (skipped) console.log(`  Skipping ${skipped} already-cached artist(s). Use --force to re-fetch.`)
  }

  // Optional limit (random sample)
  if (OPT_LIMIT && workList.length > OPT_LIMIT) {
    for (let i = workList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [workList[i], workList[j]] = [workList[j], workList[i]]
    }
    workList = workList.slice(0, OPT_LIMIT)
    console.log(`  Sampling ${OPT_LIMIT} artist(s) randomly.`)
  }

  console.log(`\nProcessing ${workList.length} artist(s)…`)
  console.log(`  Rate: ~1 req/s  |  Est. time: ~${Math.ceil(workList.length * MB_RATE_MS / 60000)} min\n`)

  let totalTags = 0, totalCollabs = 0, totalLinks = 0, totalGender = 0, totalErrors = 0, done = 0

  for (const { artist, mbid } of workList) {
    done++
    const pct = ((done / workList.length) * 100).toFixed(0)
    const cached = !FORCE && cacheRead(mbid) ? ' (cache)' : ''
    process.stdout.write(`  [${done}/${workList.length} ${pct}%] ${artist.name}${cached}… `)

    const { tags, collabs, links, gender, errors } = await processArtist(artist, mbid, mbidToArtistId)

    totalTags    += tags
    totalCollabs += collabs
    totalLinks   += links
    totalGender  += gender ? 1 : 0
    totalErrors  += errors

    const parts = []
    if (tags)   parts.push(`${tags} tag(s)`)
    if (collabs) parts.push(`${collabs} collab(s)`)
    if (links)   parts.push(`${links} link(s)`)
    if (gender)  parts.push('gender')
    if (errors)  parts.push('ERROR')
    console.log(parts.length ? parts.join(', ') : 'no new data')
  }

  console.log()
  console.log('─'.repeat(50))
  console.log(`Artists processed : ${workList.length}`)
  console.log(`Tags upserted     : ${totalTags}`)
  console.log(`Collabs upserted  : ${totalCollabs}`)
  console.log(`Links upserted    : ${totalLinks}`)
  console.log(`Gender updated    : ${totalGender}`)
  console.log(`Errors            : ${totalErrors}`)
  if (DRY_RUN) console.log('\nDry run — no data was written.')
}

main().catch(err => {
  console.error('\nFailed:', err?.message ?? err)
  process.exit(1)
})
