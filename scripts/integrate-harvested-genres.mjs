#!/usr/bin/env node
// ============================================================
// integrate-harvested-genres.mjs
//
// Promotes rows from artist_harvested_genres into the live
// genres + artist_genres tables.
//
// For each unprocessed row (genre_id IS NULL AND skipped = FALSE):
//
//   1. Normalise the raw_tag (genre_tag_rules vocabulary):
//        a. Lowercase + trim (already done at harvest time, but
//           harmless to repeat for safety).
//        b. Check against 'discard' rules → if matched, mark the
//           row skipped = TRUE and move on. Nothing is written to
//           genres or artist_genres.
//        c. Look up 'alias' rules → canonical name. If found, use
//           the canonical name; if not, use the normalised
//           raw_tag as-is.
//
//   2. Find or create the canonical genre in the genres table.
//      Genre lookup is case-insensitive; new rows are inserted
//      with the canonical casing from the alias rule (or the
//      normalised raw_tag for unknown tags).
//
//   3. Insert into artist_genres (artist_id, genre_id) — ON
//      CONFLICT DO NOTHING, so duplicate harvests from multiple
//      sources don't create double entries.
//
//   4. Update artist_harvested_genres.genre_id to point to the
//      resolved genre. This marks the row as "processed" so
//      re-runs skip it.
//
// Multiple sources (MusicBrainz, Spotify, Bandcamp, HÖR) may produce
// the same (artist_id, canonical_genre) pair. The first source
// to be integrated inserts the artist_genres row; subsequent
// sources just get their genre_id set and are otherwise a no-op.
//
// The script is safe to re-run: it only touches rows where
// genre_id IS NULL AND skipped = FALSE.
//
// ── Normalisation ─────────────────────────────────────────
//
// Raw tags are normalised before lookup and storage:
//   • Accents/diacritics are stripped  ("alté" → "alte")
//   • Hyphens are treated as spaces for matching purposes
//     ("alt-pop" and "alt pop" resolve to the same genre)
//   • Everything is stored lowercase unless an alias rule
//     specifies a different canonical form (e.g. "EBM", "IDM",
//     "UK garage").
//
// After each run a deduplication pass merges any genres that
// normalise to the same string (accent/hyphen-insensitive).
//
// ── Customising the genre vocabulary ──────────────────────
//
// The vocabulary lives in the genre_tag_rules table (see
// supabase_migration_genre_tag_rules.sql), loaded at startup via
// loadGenreVocab() in lib/genre-vocab.mjs. Edit rules in the
// admin panel (/admin/settings) or with SQL:
//
//   kind='alias'    — raw spelling → canonical display name
//   kind='discard'  — drop the tag entirely (too vague / not a genre)
//   kind='word_fix' — word substitution applied before alias lookup
//
// The script refuses to run if the table is missing or empty.
//
// ── Usage (from rebalance-gender/) ────────────────────────────
//
//   node scripts/integrate-harvested-genres.mjs
//   node scripts/integrate-harvested-genres.mjs --limit=50
//   node scripts/integrate-harvested-genres.mjs --name="nina kraviz"
//   node scripts/integrate-harvested-genres.mjs --source=musicbrainz
//   node scripts/integrate-harvested-genres.mjs --debug
//   DRY_RUN=1 node scripts/integrate-harvested-genres.mjs
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local.
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadGenreVocab, normalizeForLookup } from './lib/genre-vocab.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ------------------------------------------------------------
// CLI / env
// ------------------------------------------------------------
const args    = process.argv.slice(2)
const DRY_RUN = process.env.DRY_RUN === '1' || args.includes('--dry-run')
const DEBUG   = args.includes('--debug')

// --force-skipped: re-process rows that were previously marked skipped
// (in case a 'discard' rule was removed from genre_tag_rules).
const FORCE_SKIPPED = args.includes('--force-skipped')

const limitArg  = args.find(a => a.startsWith('--limit='))
const nameArg   = args.find(a => a.startsWith('--name='))
const sourceArg = args.find(a => a.startsWith('--source='))

const OPT_LIMIT  = limitArg  ? parseInt(limitArg.split('=')[1], 10) : null
const OPT_NAME   = nameArg   ? nameArg.split('=').slice(1).join('=').toLowerCase() : null
const OPT_SOURCE = sourceArg ? sourceArg.split('=')[1].toLowerCase() : null   // 'musicbrainz' | 'spotify' | 'bandcamp' | 'hoer'

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
// Find or create a genre by canonical name.
// Returns the genre's id.
// Uses a simple in-memory cache to avoid repeated DB round-trips
// for the same genre across many artists.
// ------------------------------------------------------------
const genreCache = new Map()   // normalizeForLookup(canonical name) → genre id

async function findOrCreateGenre(canonicalName) {
  const key = normalizeForLookup(canonicalName)
  if (genreCache.has(key)) return genreCache.get(key)

  // Try fetching first (ilike for case-insensitive match).
  const { data: existing, error: fetchErr } = await supabase
    .from('genres')
    .select('id, name')
    .ilike('name', canonicalName)
    .maybeSingle()

  if (fetchErr) throw fetchErr

  if (existing) {
    genreCache.set(key, existing.id)
    return existing.id
  }

  // Genre doesn't exist — create it.
  const { data: created, error: insertErr } = await supabase
    .from('genres')
    .insert({ name: canonicalName })
    .select('id')
    .single()

  if (insertErr) throw insertErr

  if (DEBUG) console.log(`    ✦ Created new genre: "${canonicalName}" (id ${created.id})`)
  genreCache.set(key, created.id)
  return created.id
}

// ------------------------------------------------------------
// Deduplicate genres
//
// Merges genres whose names are equivalent under accent/hyphen
// normalisation (e.g. "alte" and "alté", "alt pop" and "alt-pop").
// The genre with the most artist links wins; ties go to lowest id.
// Remaps artist_genres and artist_harvested_genres before deleting
// the duplicate genre rows.
// ------------------------------------------------------------
async function deduplicateGenres() {
  console.log('\nDeduplicating genres…')

  // 1. Fetch all genres and artist_genres (paginated — PostgREST caps at 1000/page).
  const allGenres = await fetchAllPages((from, to) =>
    supabase.from('genres').select('id, name').order('id').range(from, to))

  const allLinks = await fetchAllPages((from, to) =>
    supabase.from('artist_genres').select('artist_id, genre_id').order('artist_id').range(from, to))

  const countByGenre = new Map()
  for (const row of allLinks) {
    countByGenre.set(row.genre_id, (countByGenre.get(row.genre_id) ?? 0) + 1)
  }

  // 2. Group genres by normalised name; sort each group so canonical is first.
  const groups = new Map()
  for (const g of allGenres) {
    const norm = normalizeForLookup(g.name)
    if (!groups.has(norm)) groups.set(norm, [])
    groups.get(norm).push(g)
  }

  const remapGenre = new Map()   // duplicate id → canonical id
  for (const group of groups.values()) {
    if (group.length <= 1) continue
    group.sort((a, b) => {
      const diff = (countByGenre.get(b.id) ?? 0) - (countByGenre.get(a.id) ?? 0)
      return diff !== 0 ? diff : a.id - b.id
    })
    for (const dup of group.slice(1)) remapGenre.set(dup.id, group[0].id)
  }

  if (remapGenre.size === 0) {
    console.log('  No duplicates found.')
    return
  }

  console.log(`  ${remapGenre.size} duplicate genre(s) to merge.`)

  if (DRY_RUN) {
    for (const group of groups.values()) {
      if (group.length <= 1) continue
      console.log(`    "${group[0].name}" ← ${group.slice(1).map(g => `"${g.name}"`).join(', ')}`)
    }
    return
  }

  const dupIds = [...remapGenre.keys()]

  // 3. Remap artist_genres — for each duplicate genre id, either update
  //    the row to point to the canonical or delete it if the canonical is
  //    already linked to the same artist.
  for (const [oldId, canonicalId] of remapGenre) {
    const { data: alreadyLinked, error: e1 } = await supabase
      .from('artist_genres').select('artist_id').eq('genre_id', canonicalId)
    if (e1) throw e1
    const alreadySet = new Set(alreadyLinked.map(r => r.artist_id))

    const { data: oldRows, error: e2 } = await supabase
      .from('artist_genres').select('artist_id').eq('genre_id', oldId)
    if (e2) throw e2

    for (const row of oldRows) {
      if (alreadySet.has(row.artist_id)) {
        const { error } = await supabase.from('artist_genres')
          .delete().eq('artist_id', row.artist_id).eq('genre_id', oldId)
        if (error) console.error(`  Failed to delete artist_genre: ${error.message}`)
      } else {
        const { error } = await supabase.from('artist_genres')
          .update({ genre_id: canonicalId })
          .eq('artist_id', row.artist_id).eq('genre_id', oldId)
        if (error) console.error(`  Failed to remap artist_genre: ${error.message}`)
      }
    }
  }

  // 4. Remap artist_harvested_genres.
  const { data: ahgRows, error: ahgErr } = await supabase
    .from('artist_harvested_genres').select('id, genre_id').in('genre_id', dupIds)
  if (ahgErr) throw ahgErr

  for (const row of ahgRows) {
    const { error } = await supabase.from('artist_harvested_genres')
      .update({ genre_id: remapGenre.get(row.genre_id) }).eq('id', row.id)
    if (error) console.error(`  Failed to remap ahg row ${row.id}: ${error.message}`)
  }

  // 5. Delete the duplicate genre rows.
  const { error: delErr } = await supabase.from('genres').delete().in('id', dupIds)
  if (delErr) throw delErr

  console.log(`  Merged and removed ${dupIds.length} duplicate genre(s).`)
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(`integrate-harvested-genres${DRY_RUN ? ' (DRY RUN)' : ''}${FORCE_SKIPPED ? ' (--force-skipped)' : ''}`)
  if (OPT_SOURCE) console.log(`  source filter: ${OPT_SOURCE}`)
  console.log()

  // 0. Load the normalisation vocabulary (throws if missing/empty).
  const vocab = await loadGenreVocab(supabase)
  console.log(`Vocabulary: ${vocab.counts.alias} alias, ${vocab.counts.discard} discard, ` +
    `${vocab.counts.word_fix} word-fix rule(s) loaded from genre_tag_rules.`)

  // 1. Load unprocessed rows from artist_harvested_genres.
  console.log('Loading unprocessed rows from artist_harvested_genres…')

  const pending = await fetchAllPages((from, to) => {
    let q = supabase
      .from('artist_harvested_genres')
      .select(OPT_NAME
        ? 'id, artist_id, source_platform, raw_tag, tag_count, artists!inner(name)'
        : 'id, artist_id, source_platform, raw_tag, tag_count')
      .is('genre_id', null)
      .order('artist_id')
      .range(from, to)

    if (!FORCE_SKIPPED) q = q.eq('skipped', false)
    if (OPT_SOURCE)     q = q.eq('source_platform', OPT_SOURCE)
    if (OPT_NAME)       q = q.ilike('artists.name', `%${OPT_NAME}%`)

    return q
  })

  console.log(`  Found ${pending.length} unprocessed row(s).`)

  if (pending.length === 0) {
    console.log('\nNothing to integrate.')
    return
  }

  // Apply --limit after fetching (avoids N+1 queries per artist).
  const workList = OPT_LIMIT ? pending.slice(0, OPT_LIMIT) : pending
  if (OPT_LIMIT && pending.length > OPT_LIMIT) {
    console.log(`  Applying --limit: processing ${OPT_LIMIT} row(s).`)
  }

  // 2. Pre-load the existing genres table to warm the cache and
  //    avoid redundant inserts for genres we already have.
  console.log('Warming genre cache…')
  const existingGenres = await fetchAllPages((from, to) =>
    supabase.from('genres').select('id, name').order('id').range(from, to))
  for (const g of existingGenres) {
    genreCache.set(normalizeForLookup(g.name), g.id)
  }
  console.log(`  ${existingGenres.length} existing genre(s) loaded.`)

  // 3. Pre-load existing artist_genres pairs so we can skip inserts
  //    that are already in place (avoids relying solely on ON CONFLICT).
  console.log('Loading existing artist_genres…')
  const existingArtistGenres = await fetchAllPages((from, to) =>
    supabase.from('artist_genres').select('artist_id, genre_id').range(from, to)
  )
  const artistGenreSet = new Set(existingArtistGenres.map(r => `${r.artist_id}|${r.genre_id}`))
  console.log(`  ${existingArtistGenres.length} existing artist_genre link(s) loaded.`)
  console.log()

  // 4. Process each row.
  let promoted  = 0
  let skipped   = 0
  let alreadyLinked = 0
  let newGenres = 0
  let errors    = 0

  // Batches to write at the end (in dry-run mode, we just count).
  const artistGenresToInsert = []   // { artist_id, genre_id }
  const rowsToMarkGenre  = []       // { id, genre_id }
  const rowsToMarkSkipped = []      // id[]

  for (const row of workList) {
    const artistName = row.artists?.name ?? row.artist_id

    const { canonical, skip } = vocab.normaliseTag(row.raw_tag)

    if (skip) {
      if (DEBUG) console.log(`  ~ [${artistName}] "${row.raw_tag}" → SKIPPED (broad/noise tag)`)
      rowsToMarkSkipped.push(row.id)
      skipped++
      continue
    }

    let genreId
    try {
      const existedBefore = genreCache.has(normalizeForLookup(canonical))
      genreId = await findOrCreateGenre(canonical)
      if (!existedBefore) newGenres++
    } catch (err) {
      console.error(`  ERROR finding/creating genre "${canonical}" for ${artistName}: ${err.message}`)
      errors++
      continue
    }

    const linkKey = `${row.artist_id}|${genreId}`
    if (artistGenreSet.has(linkKey)) {
      if (DEBUG) console.log(`  = [${artistName}] "${canonical}" (id ${genreId}) already linked`)
      alreadyLinked++
    } else {
      if (DEBUG) console.log(`  + [${artistName}] "${row.raw_tag}" → "${canonical}" (id ${genreId})`)
      artistGenresToInsert.push({ artist_id: row.artist_id, genre_id: genreId })
      artistGenreSet.add(linkKey)  // prevent duplicate inserts from same run
      promoted++
    }

    rowsToMarkGenre.push({ id: row.id, genre_id: genreId })
  }

  // 5. Summary.
  console.log('─'.repeat(50))
  console.log(`Rows processed       : ${workList.length}`)
  console.log(`Artist-genre links   : ${promoted} new, ${alreadyLinked} already present`)
  console.log(`New genres created   : ${newGenres}`)
  console.log(`Rows skipped (broad) : ${skipped}`)
  console.log(`Errors               : ${errors}`)

  if (DRY_RUN) {
    console.log('\nDry run — no data written.')
    return
  }

  // 6. Write artist_genres.
  if (artistGenresToInsert.length > 0) {
    console.log(`\nInserting ${artistGenresToInsert.length} artist_genre link(s)…`)
    for (const batch of chunk(artistGenresToInsert, 500)) {
      const { error } = await supabase
        .from('artist_genres')
        .upsert(batch, { onConflict: 'artist_id,genre_id', ignoreDuplicates: true })
      if (error) console.error(`  artist_genres batch failed: ${error.message}`)
    }
  }

  // 7. Mark rows as processed (genre_id set).
  if (rowsToMarkGenre.length > 0) {
    console.log(`Marking ${rowsToMarkGenre.length} harvested row(s) as processed…`)
    for (const batch of chunk(rowsToMarkGenre, 500)) {
      for (const { id, genre_id } of batch) {
        const { error } = await supabase
          .from('artist_harvested_genres')
          .update({ genre_id })
          .eq('id', id)
        if (error) console.error(`  Failed to mark row ${id}: ${error.message}`)
      }
    }
  }

  // 8. Mark broad/noise rows as skipped.
  if (rowsToMarkSkipped.length > 0) {
    console.log(`Marking ${rowsToMarkSkipped.length} row(s) as skipped…`)
    for (const batch of chunk(rowsToMarkSkipped, 500)) {
      const { error } = await supabase
        .from('artist_harvested_genres')
        .update({ skipped: true })
        .in('id', batch)
      if (error) console.error(`  Failed to mark skipped batch: ${error.message}`)
    }
  }

  // 9. Deduplicate genres created or touched during this run.
  await deduplicateGenres()

  console.log('\nDone.')
}

// Only run the pipeline when this file is executed directly. (The
// normalisation vocabulary other scripts used to import from here now
// lives in lib/genre-vocab.mjs + the genre_tag_rules table.)
const isMainModule = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMainModule) {
  main().catch(err => {
    console.error('\nFailed:', err?.message ?? err)
    process.exit(1)
  })
}
