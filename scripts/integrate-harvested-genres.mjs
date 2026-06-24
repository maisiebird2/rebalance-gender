#!/usr/bin/env node
// ============================================================
// integrate-harvested-genres.mjs
//
// Promotes rows from artist_harvested_genres into the live
// genres + artist_genres tables.
//
// For each unprocessed row (genre_id IS NULL AND skipped = FALSE):
//
//   1. Normalise the raw_tag:
//        a. Lowercase + trim (already done at harvest time, but
//           harmless to repeat for safety).
//        b. Look up in GENRE_ALIASES → canonical name. If found,
//           use the canonical name; if not, use the normalised
//           raw_tag as-is.
//        c. Check against BROAD_TAGS → if matched, mark the row
//           skipped = TRUE and move on. Nothing is written to
//           genres or artist_genres.
//
//   2. Find or create the canonical genre in the genres table.
//      Genre lookup is case-insensitive; new rows are inserted
//      with the canonical casing from GENRE_ALIASES (or the
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
// Multiple sources (MusicBrainz, Last.fm, Spotify) may produce
// the same (artist_id, canonical_genre) pair. The first source
// to be integrated inserts the artist_genres row; subsequent
// sources just get their genre_id set and are otherwise a no-op.
//
// The script is safe to re-run: it only touches rows where
// genre_id IS NULL AND skipped = FALSE.
//
// ── Customising the genre vocabulary ──────────────────────
//
// GENRE_ALIASES  — Maps raw/alternate spellings to a canonical
//   genre name. Edit freely; keys should be lowercase. Values
//   set the display name that goes into the genres table.
//
// BROAD_TAGS  — Set of lowercase raw tags to discard entirely.
//   Add anything that is too vague, a metadata tag (e.g.
//   "seen live"), or not a real genre.
//
// Both constants are near the top of this file for easy editing.
//
// ── Usage (from wem-directory/) ────────────────────────────
//
//   node scripts/integrate-harvested-genres.mjs
//   node scripts/integrate-harvested-genres.mjs --limit=50
//   node scripts/integrate-harvested-genres.mjs --name="nina kraviz"
//   node scripts/integrate-harvested-genres.mjs --source=lastfm
//   node scripts/integrate-harvested-genres.mjs --debug
//   DRY_RUN=1 node scripts/integrate-harvested-genres.mjs
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ============================================================
// GENRE ALIASES
//
// Keys: lowercase raw tag strings (as they arrive from Last.fm /
//   MusicBrainz / Spotify).
// Values: the canonical display name to use in the genres table.
//   Casing here is what users see on the site.
//
// If a raw tag is not in this map and not in BROAD_TAGS, it is
// used as-is (title-cased by the normaliseTag() function below).
// Add aliases here whenever you spot duplicates in the staging table.
// ============================================================
const GENRE_ALIASES = new Map([
  // Drum & Bass
  ['drum and bass',               'drum & bass'],
  ['d&b',                         'drum & bass'],
  ['dnb',                         'drum & bass'],
  ['drum n bass',                 'drum & bass'],
  ["drum 'n' bass",               'drum & bass'],
  ['drum n\' bass',               'drum & bass'],
  ['liquid drum and bass',        'liquid drum & bass'],
  ['liquid d&b',                  'liquid drum & bass'],
  ['liquid dnb',                  'liquid drum & bass'],
  ['liquid drum n bass',          'liquid drum & bass'],

  // Dubstep
  ['dub step',                    'dubstep'],

  // UK Garage
  ['uk garage',                   'UK garage'],
  ['u.k. garage',                 'UK garage'],
  ['2 step',                      '2-step garage'],
  ['2-step',                      '2-step garage'],
  ['2step',                       '2-step garage'],
  ['two step',                    '2-step garage'],
  ['two-step',                    '2-step garage'],
  ['two step garage',             '2-step garage'],

  // EBM / Industrial
  ['electronic body music',       'EBM'],
  ['e.b.m.',                      'EBM'],
  ['ebm',                         'EBM'],
  ['industrial electronic',       'industrial'],
  ['industrial music',            'industrial'],

  // Techno variants (keep as distinct genres)
  ['minimal',                     'minimal techno'],
  ['micro techno',                'minimal techno'],

  // Trance
  ['psy trance',                  'psytrance'],
  ['psy-trance',                  'psytrance'],
  ['psychedelic trance',          'psytrance'],
  ['progressive psy',             'psytrance'],
  ['prog trance',                 'progressive trance'],

  // Breakbeat
  ['breaks',                      'breakbeat'],
  ['breakbeats',                  'breakbeat'],
  ['break beat',                  'breakbeat'],
  ['break-beat',                  'breakbeat'],
  ['nu breaks',                   'nu-breaks'],
  ['nu break',                    'nu-breaks'],

  // Jungle
  ['junglist',                    'jungle'],
  ['jungle music',                'jungle'],

  // Grime
  ['uk grime',                    'grime'],

  // Ambient
  ['ambient music',               'ambient'],
  ['ambient electronic',          'ambient'],
  ['ambient techno',              'ambient techno'],

  // Experimental / Noise
  ['experimental electronic',     'experimental'],
  ['experimental music',          'experimental'],
  ['noise music',                 'noise'],
  ['power electronics',           'power electronics'],

  // Electronica
  ['electronics',                 'electronica'],
  ['idm/electronica',             'electronica'],

  // IDM
  ['intelligent dance music',     'IDM'],
  ['idm',                         'IDM'],

  // Acid
  ['acid techno',                 'acid techno'],
  ['acid trance',                 'acid trance'],
  ['acid house',                  'acid house'],

  // Footwork / Juke
  ['juke',                        'footwork'],
  ['juke/footwork',               'footwork'],
  ['chicago juke',                'footwork'],

  // Club
  ['club music',                  'club'],

  // Dub
  ['roots reggae',                'reggae'],
  ['dub music',                   'dub'],
  ['digital dub',                 'dub'],

  // House variants
  ['lo-fi house',                 'lo-fi house'],
  ['lofi house',                  'lo-fi house'],

  // Berlin-School
  ['berlin school',               'Berlin-school'],
  ['berlin-school',               'Berlin-school'],

  // Gabber / Hardcore
  ['gabba',                       'gabber'],
  ['hardcore techno',             'hardcore'],
  ['hard techno',                 'hard techno'],
  ['hard trance',                 'hard trance'],
  ['hardstyle music',             'hardstyle'],

  // Bass music
  ['bass music',                  'bass'],
  ['uk bass',                     'UK bass'],

  // Drill
  ['uk drill',                    'UK drill'],

  // Afro
  ['afrohouse',                   'afro house'],
  ['afro tech',                   'afro tech'],
  ['afrobeats',                   'Afrobeats'],
  ['afro beats',                  'Afrobeats'],

  // Electronic variants that map to something more specific
  ['left field electronic',       'leftfield'],
  ['leftfield electronic',        'leftfield'],
  ['left-field',                  'leftfield'],
])

// ============================================================
// BROAD TAGS
//
// Raw tags (lowercase) that are too vague, not a real genre, or
// are metadata/listener behaviour tags. These are marked
// skipped = TRUE in artist_harvested_genres and never promoted
// to the live genres table.
//
// Err on the side of inclusion here — it's easy to remove a tag
// from this list later (then re-run with --force-skipped to
// re-process those rows). It's harder to clean up genres that
// slipped through.
// ============================================================
const BROAD_TAGS = new Set([
  // Platform / catalogue noise
  'electronic',
  'electronic music',
  'edm',
  'dance',
  'dance music',
  'music',
  'club',        // too vague on its own — kept here; use "club music" → "club" alias above if desired
  'rave',
  'club music',  // comment out if you want to keep this as a genre
  // Descriptor tags (not genres)
  'female vocalists',
  'female vocalist',
  'women in music',
  'women',
  'lgbtq',
  'queer',
  'poc',
  'black artists',
  // Last.fm listener-behaviour tags
  'seen live',
  'live',
  'favorites',
  'favourites',
  'favorite',
  'favourite',
  'love at first listen',
  'loved',
  'love',
  'best',
  'awesome',
  'good',
  'liked',
  'classic',
  'all',
  // Format / release tags
  'album',
  'albums',
  'ep',
  'single',
  'mix',
  'dj mix',
  'dj set',
  'dj',
  'producer',
  // Era / mood (too vague)
  'underground',
  'alternative',
  'alternative electronic',
  'indie',
  'indie electronic',
  'indie dance',
  // Nationality meta-tags
  'german',
  'british',
  'american',
  'uk',
  'us',
  'french',
  'german electronic',
  'british electronic',
  // Misc noise
  'spotify',
  'soundcloud',
  'bandcamp',
  'unknown',
  '???',
  'various artists',
])

// ============================================================
// Normalise a raw tag to its canonical form.
// Returns { canonical: string, skip: boolean }.
// ============================================================
function normaliseTag(rawTag) {
  const lower = rawTag.toLowerCase().trim()

  // Blocklist check first.
  if (BROAD_TAGS.has(lower)) return { canonical: null, skip: true }

  // Alias lookup.
  if (GENRE_ALIASES.has(lower)) return { canonical: GENRE_ALIASES.get(lower), skip: false }

  // Unknown tag — use as-is but with basic title-casing for readability.
  // Don't title-case known acronyms (EBM, IDM, UK, DnB…) — those come
  // from GENRE_ALIASES above so we never reach here for them.
  const titleCased = lower
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

  return { canonical: titleCased, skip: false }
}

// ------------------------------------------------------------
// CLI / env
// ------------------------------------------------------------
const args    = process.argv.slice(2)
const DRY_RUN = process.env.DRY_RUN === '1' || args.includes('--dry-run')
const DEBUG   = args.includes('--debug')

// --force-skipped: re-process rows that were previously marked skipped
// (in case BROAD_TAGS was updated to remove something).
const FORCE_SKIPPED = args.includes('--force-skipped')

const limitArg  = args.find(a => a.startsWith('--limit='))
const nameArg   = args.find(a => a.startsWith('--name='))
const sourceArg = args.find(a => a.startsWith('--source='))

const OPT_LIMIT  = limitArg  ? parseInt(limitArg.split('=')[1], 10) : null
const OPT_NAME   = nameArg   ? nameArg.split('=').slice(1).join('=').toLowerCase() : null
const OPT_SOURCE = sourceArg ? sourceArg.split('=')[1].toLowerCase() : null   // 'lastfm' | 'musicbrainz' | 'spotify'

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
const genreCache = new Map()   // lowercase canonical name → genre id

async function findOrCreateGenre(canonicalName) {
  const key = canonicalName.toLowerCase()
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
// Main
// ------------------------------------------------------------
async function main() {
  console.log(`integrate-harvested-genres${DRY_RUN ? ' (DRY RUN)' : ''}${FORCE_SKIPPED ? ' (--force-skipped)' : ''}`)
  if (OPT_SOURCE) console.log(`  source filter: ${OPT_SOURCE}`)
  console.log()

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
  const { data: existingGenres, error: genreErr } = await supabase
    .from('genres')
    .select('id, name')
  if (genreErr) throw genreErr
  for (const g of existingGenres) {
    genreCache.set(g.name.toLowerCase(), g.id)
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

    const { canonical, skip } = normaliseTag(row.raw_tag)

    if (skip) {
      if (DEBUG) console.log(`  ~ [${artistName}] "${row.raw_tag}" → SKIPPED (broad/noise tag)`)
      rowsToMarkSkipped.push(row.id)
      skipped++
      continue
    }

    let genreId
    try {
      const existedBefore = genreCache.has(canonical.toLowerCase())
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

  console.log('\nDone.')
}

main().catch(err => {
  console.error('\nFailed:', err?.message ?? err)
  process.exit(1)
})
