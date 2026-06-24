#!/usr/bin/env node
/**
 * resolve-and-load-links-lf-mb-sp.mjs
 *
 * Automated pipeline:
 *   1. Search Last.fm, MusicBrainz, and Spotify for each artist by name
 *   2. Score and classify candidates (best match / close match / tie / pending)
 *   3. Upsert results to the pending_artist_links staging table
 *   4. Export a full CSV record of all staged candidates
 *   5. Load every 'best match' row into artist_links and mark it 'loaded'
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   LASTFM_API_KEY
 *   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
 *
 * Usage:
 *   node scripts/resolve-and-load-links-lf-mb-sp.mjs
 *   node scripts/resolve-and-load-links-lf-mb-sp.mjs --artist "Bicep"   # one artist
 *   node scripts/resolve-and-load-links-lf-mb-sp.mjs --limit 10         # first N artists only
 *   node scripts/resolve-and-load-links-lf-mb-sp.mjs --service lastfm   # one service only
 *   node scripts/resolve-and-load-links-lf-mb-sp.mjs --force            # re-process already-resolved pairs
 *   node scripts/resolve-and-load-links-lf-mb-sp.mjs --dry-run          # score only, no DB writes or CSV
 *   node scripts/resolve-and-load-links-lf-mb-sp.mjs --no-load          # stage candidates but skip loading into artist_links
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { isBlankArtistName } from './lib/name-utils.mjs'
// ── Environment ───────────────────────────────────────────────────────────────
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
const REQUIRED_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY',
  'LASTFM_API_KEY', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET',
]
const missing = REQUIRED_VARS.filter(k => !process.env[k])
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
)
// ── CLI ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const getArg  = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const hasFlag = name => argv.includes(name)
const OPT_ARTIST  = getArg('--artist')
const OPT_LIMIT   = getArg('--limit') ? parseInt(getArg('--limit'), 10) : null
const OPT_SERVICE = getArg('--service')
const OPT_FORCE   = hasFlag('--force')
const OPT_DRY_RUN = hasFlag('--dry-run')
const OPT_NO_LOAD = hasFlag('--no-load')
const ALL_SERVICES = ['lastfm', 'musicbrainz', 'spotify']
if (OPT_SERVICE && !ALL_SERVICES.includes(OPT_SERVICE)) {
  console.error(`Unknown service "${OPT_SERVICE}". Choose from: ${ALL_SERVICES.join(', ')}`)
  process.exit(1)
}
const SERVICES = OPT_SERVICE ? [OPT_SERVICE] : ALL_SERVICES
const CANDIDATES_PER_SERVICE = 5
const BEST_MATCH_THRESHOLD   = 0.95  // minimum confidence to auto-load as 'best match'
const CLOSE_MATCH_THRESHOLD  = 0.95  // kept for 'close match' label on non-winners
// ── Logging ───────────────────────────────────────────────────────────────────
const fmt = (level, msg) =>
  `${new Date().toTimeString().slice(0, 8)} ${level.padEnd(8)} ${msg}`
const log  = (msg, ...a) => console.log(fmt('INFO',    msg), ...a)
const warn = (msg, ...a) => console.warn(fmt('WARNING', msg), ...a)
const err  = (msg, ...a) => console.error(fmt('ERROR',  msg), ...a)
// ── Disk cache ────────────────────────────────────────────────────────────────
const CACHE_DIR = path.resolve(__dirname, '..', '.cache')
function cacheGet(ns, key) {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(CACHE_DIR, ns, createHash('md5').update(key).digest('hex') + '.json'), 'utf8'
    ))
  } catch { return null }
}
function cacheSet(ns, key, value) {
  const dir = path.join(CACHE_DIR, ns)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, createHash('md5').update(key).digest('hex') + '.json'),
    JSON.stringify(value)
  )
}
// ── Rate limiters ─────────────────────────────────────────────────────────────
function makeThrottle(ms) {
  let last = 0
  return () => {
    const wait = ms - (Date.now() - last)
    if (wait <= 0) { last = Date.now(); return Promise.resolve() }
    return new Promise(r => setTimeout(() => { last = Date.now(); r() }, wait))
  }
}
const throttleLfm     = makeThrottle(260)   // Last.fm: ~4 req/s
const throttleMb      = makeThrottle(1100)  // MusicBrainz: 1 req/s (strict)
const throttleSpotify = makeThrottle(100)   // Spotify: generous
// ── Scoring ───────────────────────────────────────────────────────────────────
//
// Ported from recommender/scoring.py. Each signal returns 0–1 (or null if
// data is unavailable). Weights are renormalised when a signal is absent.
const SCORE_WEIGHTS = { name: 0.67, location: 0.20, bio: 0.09, popularity: 0.04 }
const NAME_STOPS = new Set([
  'the','a','an','and','or','of','in','at','de','la','el','les','los','das','die','der',
])
const LOC_STOPS = new Set([
  'the','of','and','in','at','city','town','village','county','state','province','region','district',
])
const BIO_STOPS = new Set([
  'that','this','with','from','have','been','their','they','were','also','some','more',
  'when','which','band','artist','music','song','album','known',
])
// Levenshtein distance (O(m·n) — fine for short artist names)
function lev(s, t) {
  const m = s.length, n = t.length
  if (!m) return n; if (!n) return m
  const row = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    let prev = row[0]; row[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]
      row[j] = s[i-1] === t[j-1] ? prev : 1 + Math.min(prev, row[j], row[j-1])
      prev = tmp
    }
  }
  return row[n]
}
function strRatio(a, b) {
  const max = Math.max(a.length, b.length)
  return max === 0 ? 1.0 : (max - lev(a, b)) / max
}
// token_set_ratio equivalent: handles word-order differences and "The X" vs "X"
function tokenSetRatio(a, b) {
  const tok = s => s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean)
  const tA = new Set(tok(a)), tB = new Set(tok(b))
  const inter  = [...tA].filter(t => tB.has(t)).sort()
  const onlyA  = [...tA].filter(t => !tB.has(t)).sort()
  const onlyB  = [...tB].filter(t => !tA.has(t)).sort()
  const sI     = inter.join(' ')
  const sIA    = [sI, ...onlyA].filter(Boolean).join(' ')
  const sIB    = [sI, ...onlyB].filter(Boolean).join(' ')
  return Math.max(strRatio(sI, sIA), strRatio(sI, sIB), strRatio(sIA, sIB))
}
function scoreName(ours, theirs) {
  if (!ours || !theirs) return 0.0
  const tsr = tokenSetRatio(ours, theirs)
  const ntok = s => new Set(
    s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t && !NAME_STOPS.has(t))
  )
  const tO = ntok(ours),  tT = ntok(theirs)
  if (!tO.size || !tT.size) return tsr
  const matched = [...tO].filter(t => tT.has(t)).length
  const covO = matched / tO.size, covT = matched / tT.size
  const f1   = (covO + covT) > 0 ? 2 * covO * covT / (covO + covT) : 0
  return tsr * f1
}
function scoreLocation(ours, theirs) {
  if (!ours || !theirs) return null
  const tok = s => new Set(s.toLowerCase().split(/[,/\s]+/).filter(t => t && !LOC_STOPS.has(t)))
  const tO = tok(ours), tT = tok(theirs)
  if (!tO.size || !tT.size) return null
  const inter = [...tO].filter(t => tT.has(t)).length
  return Math.min(inter / Math.min(tO.size, tT.size), 1.0)
}
function scoreBio(ours, theirs) {
  if (!ours || !theirs) return null
  const kw = s => new Set((s.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []).filter(w => !BIO_STOPS.has(w)))
  const kO = kw(ours), kT = kw(theirs)
  if (!kO.size || !kT.size) return null
  return Math.min([...kO].filter(w => kT.has(w)).length / kO.size, 1.0)
}
function scorePopularity(ourBio, popularity, listeners) {
  let score = null
  if (popularity != null) {
    const bioLen = (ourBio ?? '').length
    score = popularity >= 80 && bioLen < 100
      ? 0.5
      : Math.max(1.0 - Math.max(0, (popularity - 70) / 100), 0.3)
  }
  if (listeners != null) {
    const s = listeners > 5_000_000 ? 0.5 : listeners > 1_000_000 ? 0.75 : 1.0
    score = Math.min(score ?? 1.0, s)
  }
  return score
}
function combineScores(scores) {
  let wSum = 0, wTotal = 0
  for (const [sig, val] of Object.entries(scores)) {
    if (val == null) continue
    const w = SCORE_WEIGHTS[sig] ?? 0
    wSum += w * val; wTotal += w
  }
  return wTotal > 0 ? wSum / wTotal : 0.0
}
function scoreCandidate({ ourName, ourLocation, ourBio, candidateName, candidateLocation, candidateBio, candidatePopularity = null, candidateListeners = null }) {
  const sName = scoreName(ourName, candidateName)
  const sLoc  = scoreLocation(ourLocation, candidateLocation)
  const sBio  = scoreBio(ourBio, candidateBio)
  const sPop  = scorePopularity(ourBio, candidatePopularity, candidateListeners)
  return {
    confidence:       combineScores({ name: sName, location: sLoc, bio: sBio, popularity: sPop }),
    score_name:       sName,
    score_genre:      null,   // kept for DB column compatibility
    score_location:   sLoc,
    score_bio:        sBio,
    score_popularity: sPop,
  }
}
// ── Status assignment ─────────────────────────────────────────────────────────
function breakTie(ourName, candidates) {
  const exact = candidates.filter(c => c.external_name.trim().toLowerCase() === ourName.trim().toLowerCase())
  if (exact.length === 1) return exact[0]
  const pool   = exact.length > 1 ? exact : candidates
  const minLen = Math.min(...pool.map(c => c.external_name.length))
  const short  = pool.filter(c => c.external_name.length === minLen)
  return short.length === 1 ? short[0] : null
}
function assignStatuses(ourName, candidates) {
  if (!candidates.length) return []
  candidates.sort((a, b) => b.scores.confidence - a.scores.confidence)
  const topConf = candidates[0].scores.confidence
  const top     = candidates.filter(c => c.scores.confidence === topConf)
  let winnerId = null, tieIds = new Set()
  if (top.length === 1) {
    winnerId = top[0].external_id
  } else {
    const winner = breakTie(ourName, top)
    if (winner) winnerId = winner.external_id
    else tieIds = new Set(top.map(c => c.external_id))
  }
  return candidates.map(c => ({
    ...c,
    status: winnerId && c.external_id === winnerId
              ? (c.scores.confidence >= BEST_MATCH_THRESHOLD ? 'best match' : 'pending')
          : tieIds.has(c.external_id)              ? 'tie'
          : c.scores.confidence >= CLOSE_MATCH_THRESHOLD ? 'close match'
          : 'pending',
  }))
}
function buildUrl(service, externalId, externalName) {
  if (service === 'lastfm')      return `https://www.last.fm/music/${encodeURIComponent(externalName)}`
  if (service === 'musicbrainz') return `https://musicbrainz.org/artist/${externalId}`
  if (service === 'spotify')     return `https://open.spotify.com/artist/${externalId}`
  throw new Error(`Unknown service: ${service}`)
}
// ── API: Last.fm ──────────────────────────────────────────────────────────────
async function lfmRequest(params) {
  await throttleLfm()
  const qs = new URLSearchParams({ ...params, api_key: process.env.LASTFM_API_KEY, format: 'json' })
  const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${qs}`)
  if (!res.ok) throw new Error(`Last.fm HTTP ${res.status}`)
  return res.json()
}
async function lfmTopTags(artistName) {
  const ck = `tags:${artistName}`
  const hit = cacheGet('lastfm_tags', ck)
  if (hit !== null) return hit
  try {
    const data = await lfmRequest({ method: 'artist.getTopTags', artist: artistName, autocorrect: '1' })
    if (data.error) { cacheSet('lastfm_tags', ck, []); return [] }
    const tags = (data?.toptags?.tag ?? []).slice(0, 10).map(t => t.name.toLowerCase())
    cacheSet('lastfm_tags', ck, tags)
    return tags
  } catch { return [] }
}
async function searchLastfm(artistName, limit) {
  const ck = `search:${artistName}:${limit}`
  const hit = cacheGet('lastfm_search', ck)
  if (hit !== null) return hit
  const data = await lfmRequest({ method: 'artist.search', artist: artistName, limit: String(limit) })
  let raw = data?.results?.artistmatches?.artist ?? []
  if (!Array.isArray(raw)) raw = [raw]
  const candidates = []
  for (const a of raw) {
    const name      = a.name ?? ''
    const listeners = parseInt(a.listeners ?? '0', 10) || null
    const tags      = await lfmTopTags(name)
    candidates.push({
      external_id:   name,   // Last.fm uses the canonical name as its identifier
      external_name: name,
      location:      null,
      bio:           null,
      listeners:     listeners && listeners > 0 ? listeners : null,
      api_data:      { name, listeners, mbid: a.mbid ?? null, url: a.url ?? null, tags },
    })
  }
  cacheSet('lastfm_search', ck, candidates)
  return candidates
}
// ── API: MusicBrainz ──────────────────────────────────────────────────────────
async function searchMusicBrainz(artistName, limit) {
  const ck = `search:${artistName}:${limit}`
  const hit = cacheGet('mb_search', ck)
  if (hit !== null) return hit
  await throttleMb()
  const qs  = new URLSearchParams({ query: `artist:"${artistName}"`, limit: String(limit), fmt: 'json' })
  const res = await fetch(`https://musicbrainz.org/ws/2/artist?${qs}`, {
    headers: { 'User-Agent': 'WEMDirectory/1.0 (contact via site)' },
  })
  if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`)
  const data = await res.json()
  const candidates = (data.artists ?? []).map(a => {
    const beginArea = a['begin-area']?.name ?? null
    const area      = a.area?.name ?? null
    return {
      external_id:   a.id,
      external_name: a.name ?? a['sort-name'] ?? '',
      location:      beginArea ?? area,
      bio:           a.disambiguation || null,
      listeners:     null,
      api_data: {
        mbid:           a.id,
        name:           a.name,
        disambiguation: a.disambiguation ?? null,
        type:           a.type ?? null,
        area,
        begin_area:     beginArea,
        country:        a.country ?? null,
        tags:           (a.tags ?? []).map(t => t.name),
        mb_score:       parseInt(a.score ?? '0', 10),
      },
    }
  })
  cacheSet('mb_search', ck, candidates)
  return candidates
}
// ── API: Spotify ──────────────────────────────────────────────────────────────
let _spotifyToken = null, _spotifyExpiry = 0
async function spotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyExpiry) return _spotifyToken
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:  'Basic ' + Buffer.from(
        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
      ).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error(`Spotify auth failed: HTTP ${res.status}`)
  const data = await res.json()
  _spotifyToken  = data.access_token
  _spotifyExpiry = Date.now() + (data.expires_in - 60) * 1000
  return _spotifyToken
}
async function searchSpotify(artistName, limit) {
  const ck  = `search:${artistName}:${limit}`
  const hit = cacheGet('spotify_search', ck)
  if (hit !== null) return hit
  await throttleSpotify()
  const token = await spotifyToken()
  const qs    = new URLSearchParams({ q: `artist:${artistName}`, type: 'artist', limit: String(limit) })
  const res   = await fetch(`https://api.spotify.com/v1/search?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) { _spotifyToken = null; return searchSpotify(artistName, limit) }
  if (!res.ok) throw new Error(`Spotify HTTP ${res.status}`)
  const data = await res.json()
  const candidates = (data?.artists?.items ?? []).map(a => ({
    external_id:   a.id,
    external_name: a.name,
    location:      null,
    bio:           null,
    listeners:     null,
    popularity:    a.popularity ?? null,
    api_data: {
      spotify_id: a.id,
      name:       a.name,
      genres:     a.genres ?? [],
      popularity: a.popularity ?? null,
      followers:  a.followers?.total ?? null,
      url:        a.external_urls?.spotify ?? null,
    },
  }))
  cacheSet('spotify_search', ck, candidates)
  return candidates
}
// ── Per-service resolution ─────────────────────────────────────────────────────
async function resolveService(artist, service) {
  let raw
  if (service === 'lastfm')           raw = await searchLastfm(artist.name, CANDIDATES_PER_SERVICE)
  else if (service === 'musicbrainz') raw = await searchMusicBrainz(artist.name, CANDIDATES_PER_SERVICE)
  else if (service === 'spotify')     raw = await searchSpotify(artist.name, CANDIDATES_PER_SERVICE)
  const scored = raw.map(c => ({
    ...c,
    scores: scoreCandidate({
      ourName:             artist.name,
      ourLocation:         artist.location,
      ourBio:              artist.bio,
      candidateName:       c.external_name,
      candidateLocation:   c.location,
      candidateBio:        c.bio,
      candidatePopularity: c.popularity ?? null,
      candidateListeners:  c.listeners ?? null,
    }),
  }))
  return assignStatuses(artist.name, scored)
}
// ── Database helpers ───────────────────────────────────────────────────────────
async function fetchArtists() {
  const { data: artists, error } = await supabase
    .from('artists').select('id, name').order('name')
  if (error) throw error
  const { data: locs } = await supabase
    .from('artist_locations').select('artist_id, city, country')
  const locMap = {}
  for (const l of locs ?? []) {
    const parts = [l.city, l.country].filter(Boolean).join(', ')
    if (parts) (locMap[l.artist_id] ??= []).push(parts)
  }
  const { data: bios } = await supabase
    .from('artist_enrichment').select('artist_id, bio')
  const bioMap = Object.fromEntries((bios ?? []).filter(e => e.bio).map(e => [e.artist_id, e.bio]))
  return artists.map(a => ({
    id:       a.id,
    name:     a.name,
    location: locMap[a.id]?.join('; ') ?? null,
    bio:      bioMap[a.id] ?? null,
  }))
}
async function artistsWithSpotifyLink() {
  const { data } = await supabase
    .from('artist_links').select('artist_id').eq('platform', 'spotify')
  return new Set((data ?? []).map(r => r.artist_id))
}
async function alreadyResolved(artistId, service) {
  const { data } = await supabase
    .from('pending_artist_links')
    .select('id').eq('artist_id', artistId).eq('service', service).limit(1)
  return (data?.length ?? 0) > 0
}
async function upsertCandidates(artistId, service, candidates) {
  // Fetch existing statuses so we can preserve explicit rejections / skips
  const { data: existing } = await supabase
    .from('pending_artist_links')
    .select('external_id, status')
    .eq('artist_id', artistId).eq('service', service)
  const existingStatus = new Map((existing ?? []).map(r => [r.external_id, r.status]))
  const rows = candidates.map((c, i) => {
    const prev   = existingStatus.get(c.external_id)
    const status = ['rejected', 'skipped'].includes(prev) ? prev : c.status
    return {
      artist_id:        artistId,
      service,
      candidate_rank:   i + 1,
      external_id:      c.external_id,
      external_name:    c.external_name,
      url:              buildUrl(service, c.external_id, c.external_name),
      confidence:       c.scores.confidence,
      score_name:       c.scores.score_name,
      score_genre:      null,
      score_location:   c.scores.score_location,
      score_bio:        c.scores.score_bio,
      score_popularity: c.scores.score_popularity,
      api_data:         c.api_data ?? {},
      status,
    }
  })
  const { error } = await supabase
    .from('pending_artist_links')
    .upsert(rows, { onConflict: 'artist_id,service,external_id' })
  if (error) throw error
}
async function loadBestMatches(services) {
  const { data: rows, error } = await supabase
    .from('pending_artist_links')
    .select('id, artist_id, service, url')
    .eq('status', 'best match')
    .in('service', services)
  if (error) throw error
  if (!rows?.length) return { loaded: 0, skipped: 0 }
  // Fetch existing artist_links for these artist+platform pairs so we never
  // overwrite a link that came from a different source (e.g. manually added).
  const artistIds = [...new Set(rows.map(r => r.artist_id))]
  const { data: existingLinks } = await supabase
    .from('artist_links')
    .select('artist_id, platform')
    .in('artist_id', artistIds)
    .in('platform', services)
  const alreadyLinked = new Set(
    (existingLinks ?? []).map(l => `${l.artist_id}:${l.platform}`)
  )
  let loaded = 0, skipped = 0
  for (const row of rows) {
    if (!row.url) { skipped++; continue }
    // Skip if a link for this artist+platform already exists from another source
    if (alreadyLinked.has(`${row.artist_id}:${row.service}`)) {
      warn(`Skipping ${row.service} load for artist ${row.artist_id} — link already exists in artist_links.`)
      skipped++
      continue
    }
    const { error: linkErr } = await supabase
      .from('artist_links')
      .insert({ artist_id: row.artist_id, platform: row.service, url: row.url })
    if (linkErr) {
      warn(`Could not write artist_links row for pending id ${row.id}: ${linkErr.message}`)
      continue
    }
    await supabase
      .from('pending_artist_links')
      .update({ status: 'loaded', reviewed_at: new Date().toISOString() })
      .eq('id', row.id)
    loaded++
  }
  return { loaded, skipped }
}
// ── CSV export ─────────────────────────────────────────────────────────────────
async function exportCsv() {
  const { data: rows, error } = await supabase
    .from('pending_artist_links')
    .select('artist_id, service, candidate_rank, external_name, external_id, url, confidence, score_name, score_location, score_bio, score_popularity, status, api_data')
    .order('service').order('candidate_rank')
  if (error) throw error
  const { data: artists } = await supabase.from('artists').select('id, name')
  const nameMap = new Map((artists ?? []).map(a => [a.id, a.name]))
  const FIELDS = [
    'artist_name','service','rank','external_name','external_id','url',
    'confidence','score_name','score_location','score_bio','score_popularity',
    'status','api_genres','api_location','api_bio',
  ]
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = [FIELDS.join(',')]
  for (const r of rows ?? []) {
    const api = typeof r.api_data === 'string' ? JSON.parse(r.api_data) : (r.api_data ?? {})
    lines.push([
      esc(nameMap.get(r.artist_id) ?? ''),
      esc(r.service),
      r.candidate_rank,
      esc(r.external_name),
      esc(r.external_id),
      esc(r.url),
      (r.confidence ?? 0).toFixed(3),
      (r.score_name ?? 0).toFixed(2),
      r.score_location  != null ? r.score_location.toFixed(2)  : '',
      r.score_bio       != null ? r.score_bio.toFixed(2)       : '',
      r.score_popularity != null ? r.score_popularity.toFixed(2) : '',
      esc(r.status),
      esc([...(api.genres ?? []), ...(api.tags ?? [])].join('; ')),
      esc(api.area ?? api.begin_area ?? ''),
      esc(api.disambiguation ?? ''),
    ].join(','))
  }
  const date    = new Date().toISOString().slice(0, 10)
  const outPath = path.resolve(__dirname, '..', `resolve-candidates-${date}.csv`)
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8')
  log(`Exported ${lines.length - 1} rows → ${path.basename(outPath)}`)
  return outPath
}
// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('Starting resolve-and-load-links-lf-mb-sp' + (OPT_DRY_RUN ? ' (DRY RUN)' : '') + '…')
  log('Fetching artists from database…')
  let artists = await fetchArtists()
  if (OPT_ARTIST) {
    artists = artists.filter(a => a.name.toLowerCase() === OPT_ARTIST.toLowerCase())
    if (!artists.length) { err(`Artist "${OPT_ARTIST}" not found.`); process.exit(1) }
  }
  if (OPT_LIMIT) {
    // Shuffle and take N, so --limit gives a random sample rather than the first N alphabetically.
    for (let i = artists.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [artists[i], artists[j]] = [artists[j], artists[i]]
    }
    artists = artists.slice(0, OPT_LIMIT)
  }
  const withSpotify  = await artistsWithSpotifyLink()
  const spotifySkips = SERVICES.includes('spotify')
    ? artists.filter(a => withSpotify.has(a.id)).length : 0
  if (spotifySkips > 0)
    log(`Skipping Spotify search for ${spotifySkips} artist(s) that already have a Spotify URL.`)
  log(`Processing ${artists.length} artist(s) across: ${SERVICES.join(', ')}`)
  let processed = 0, errors = 0
  const skipCounts = Object.fromEntries(ALL_SERVICES.map(s => [s, 0]))
  for (let i = 0; i < artists.length; i++) {
    const artist = artists[i]
    if (isBlankArtistName(artist.name)) {
      warn(`Skipping artist ${artist.id} — name is blank or invisible characters only.`)
      continue
    }
    for (const service of SERVICES) {
      if (service === 'spotify' && withSpotify.has(artist.id)) continue
      if (!OPT_FORCE && !OPT_DRY_RUN && await alreadyResolved(artist.id, service)) {
        skipCounts[service]++
        continue
      }
      try {
        const candidates = await resolveService(artist, service)
        if (!candidates.length) continue
        const ties = candidates.filter(c => c.status === 'tie')
        if (ties.length)
          warn(`Unresolvable tie for "${artist.name}" / ${service} (conf ${ties[0].scores.confidence.toFixed(3)})`)
        if (!OPT_DRY_RUN) {
          await upsertCandidates(artist.id, service, candidates)
        } else {
          const STATUS_ICON = { 'best match': '✓', 'close match': '~', tie: '=', pending: '·' }
          const svcLabel = service.padEnd(12)
          console.log(`\n  ${artist.name}  /  ${svcLabel}`)
          for (const c of candidates) {
            const icon   = STATUS_ICON[c.status] ?? '?'
            const conf   = c.scores.confidence.toFixed(3)
            const name   = c.scores.score_name   != null ? `name=${c.scores.score_name.toFixed(2)}`   : ''
            const loc    = c.scores.score_location != null ? `loc=${c.scores.score_location.toFixed(2)}`  : ''
            const bio    = c.scores.score_bio      != null ? `bio=${c.scores.score_bio.toFixed(2)}`      : ''
            const pop    = c.scores.score_popularity != null ? `pop=${c.scores.score_popularity.toFixed(2)}` : ''
            const subs   = [name, loc, bio, pop].filter(Boolean).join('  ')
            const extra  = c.api_data?.disambiguation ? `  (${c.api_data.disambiguation})` : ''
            const area   = c.api_data?.begin_area ?? c.api_data?.area ?? ''
            const loc2   = area ? `  [${area}]` : ''
            console.log(`    ${icon} [${conf}]  ${c.external_name}${extra}${loc2}`)
            if (subs) console.log(`             ${subs}`)
          }
        }
        processed++
      } catch (e) {
        warn(`Failed "${artist.name}" / ${service}: ${e.message}`)
        errors++
      }
    }
    if ((i + 1) % 50 === 0 || i + 1 === artists.length)
      log(`Progress: ${i + 1}/${artists.length} artists`)
  }
  for (const [svc, count] of Object.entries(skipCounts))
    if (count > 0) log(`Skipped ${count} already-resolved ${svc} pair(s) (use --force to re-process).`)
  log(`Resolution complete — ${processed} pair(s) processed, ${errors} error(s).`)
  if (OPT_DRY_RUN) { log('Dry run complete — no changes written.'); return }
  log('Exporting CSV record of all staged candidates…')
  try { await exportCsv() } catch (e) { warn(`CSV export failed: ${e.message}`) }
  if (!OPT_NO_LOAD) {
    log('Loading best match rows into artist_links…')
    try {
      const { loaded, skipped } = await loadBestMatches(SERVICES)
      log(`Done — ${loaded} link(s) written to artist_links${skipped ? `, ${skipped} skipped` : ''}.`)
    } catch (e) { err(`Load step failed: ${e.message}`) }
  } else {
    log('Skipping load step (--no-load).')
  }
}
main().catch(e => { err(e.message); process.exit(1) })
