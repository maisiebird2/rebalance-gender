#!/usr/bin/env node
// ============================================================
// genre-report.mjs
//
// Read-only. Produces a CSV of every genre with its usage, to
// support paring down the genre vocabulary. Writes nothing to
// the database.
//
// For each genre it reports:
//   id, name, status,
//   artist_count      – # of artists linked (artist_genres)
//   harvested_count   – # of raw harvested rows resolved to it
//   alias_canonical   – if the alias map would resolve this name
//                       to a DIFFERENT canonical, that name (i.e.
//                       this row is a merge candidate for
//                       dedupe-genres-by-alias.mjs); blank otherwise
//   is_broad_tag      – TRUE if the name matches BROAD_TAGS
//   suspected_non_genre – reason string if the name looks like a
//                       place / decade / role / library tag (via
//                       non-genre-hints.mjs) OR exactly matches an
//                       artist name in the artists table ("artist
//                       name"); blank if it looks like a real genre.
//                       HINT-only — for human review, never auto-cut.
//
// Rows are sorted by artist_count ASCENDING so the long tail of
// rarely-used genres (the bulk of the cleanup) floats to the top.
//
// Also prints a summary: total genres, how many fall under each
// artist-count threshold, and totals for merge candidates /
// broad-tag rows.
//
// ── Usage ─────────────────────────────────────────────────
//   node scripts/genre-report.mjs
//        Writes genre-report.csv in the repo root and prints a summary.
//
//   node scripts/genre-report.mjs --out=/tmp/genres.csv
//        Custom output path.
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normaliseTag, normalizeForLookup } from './integrate-harvested-genres.mjs'
import { nonGenreReason } from './lib/non-genre-hints.mjs'

// ── CLI ──────────────────────────────────────────────────
const args   = process.argv.slice(2)
const outArg = args.find(a => a.startsWith('--out='))
const OUT    = outArg ? outArg.split('=').slice(1).join('=') : path.resolve(process.cwd(), 'genre-report.csv')

// ── Env ──────────────────────────────────────────────────
function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (!fs.existsSync(envPath)) return
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
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
const supabase = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false } })

// ── Pagination (PostgREST caps a single select at ~1000 rows) ──
const PAGE_SIZE = 1000
async function fetchAllPages(buildQuery) {
  const out = []
  let from = 0
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    out.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return out
}

function csvCell(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Normalise a name for artist↔genre matching: strip accents, drop
// punctuation used as separators, collapse spaces, lowercase.
function normalizeName(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim()
}

async function main() {
  console.log('Loading genres, links and artist names…')
  const genres = await fetchAllPages(() => supabase.from('genres').select('id, name, status'))
  const links  = await fetchAllPages(() => supabase.from('artist_genres').select('genre_id'))
  const harv   = await fetchAllPages(() =>
    supabase.from('artist_harvested_genres').select('genre_id').not('genre_id', 'is', null))
  const artists = await fetchAllPages(() => supabase.from('artists').select('name'))

  const artistCount = new Map()
  for (const r of links) artistCount.set(r.genre_id, (artistCount.get(r.genre_id) ?? 0) + 1)
  const harvCount = new Map()
  for (const r of harv) harvCount.set(r.genre_id, (harvCount.get(r.genre_id) ?? 0) + 1)

  // Set of normalised artist names, to flag genres that are really an
  // artist's name mis-tagged as a genre (e.g. "ariana grande", "actress").
  const artistNames = new Set()
  for (const a of artists) if (a.name) artistNames.add(normalizeName(a.name))

  const rows = genres.map(g => {
    const { canonical, skip } = normaliseTag(g.name)
    const isBroad = skip
    // Merge candidate if the alias map resolves this name to a different canonical.
    const aliasCanonical =
      !skip && canonical &&
      normalizeForLookup(canonical) !== normalizeForLookup(g.name)
        ? canonical : ''
    // Heuristic reason first; fall back to an exact artist-name match.
    const reason = nonGenreReason(g.name) ||
      (artistNames.has(normalizeName(g.name)) ? 'artist name' : '')
    return {
      id: g.id,
      name: g.name,
      status: g.status,
      artist_count: artistCount.get(g.id) ?? 0,
      harvested_count: harvCount.get(g.id) ?? 0,
      alias_canonical: aliasCanonical,
      is_broad_tag: isBroad ? 'TRUE' : '',
      suspected_non_genre: reason,
    }
  })

  rows.sort((a, b) =>
    a.artist_count - b.artist_count || a.name.localeCompare(b.name))

  const header = ['id', 'name', 'status', 'artist_count', 'harvested_count', 'alias_canonical', 'is_broad_tag', 'suspected_non_genre']
  const csv = [header.join(',')]
    .concat(rows.map(r => header.map(h => csvCell(r[h])).join(',')))
    .join('\n')
  fs.writeFileSync(OUT, csv)

  // ── Summary ──
  const thresholds = [0, 1, 2, 3, 5, 10]
  const under = t => rows.filter(r => r.artist_count <= t).length
  const mergeCandidates = rows.filter(r => r.alias_canonical).length
  const broad = rows.filter(r => r.is_broad_tag).length
  const nonGenre = rows.filter(r => r.suspected_non_genre)
  const artistNameHits = rows.filter(r => r.suspected_non_genre === 'artist name')

  console.log(`\nTotal genres: ${rows.length}`)
  console.log('Genres with artist_count ≤ N:')
  for (const t of thresholds) console.log(`   ≤ ${String(t).padStart(2)} artists: ${under(t)}`)
  console.log(`Alias merge candidates (fixable via dedupe script): ${mergeCandidates}`)
  console.log(`Rows matching BROAD_TAGS (probably not real genres): ${broad}`)
  console.log(`Suspected non-genres (places, decades, metadata, roles, junk): ${nonGenre.length}`)
  console.log(`   …of which match an artist name exactly: ${artistNameHits.length}`)
  if (artistNameHits.length) {
    console.log('   e.g. ' + artistNameHits.slice(0, 20).map(r => `"${r.name}"`).join(', ') +
      (artistNameHits.length > 20 ? ', …' : ''))
  }
  console.log(`\nWrote ${OUT}`)
  console.log('Open it sorted by artist_count to see the long tail.')
}

const isMainModule = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMainModule) {
  main().catch(err => { console.error('\nFailed:', err?.message ?? err); process.exit(1) })
}
