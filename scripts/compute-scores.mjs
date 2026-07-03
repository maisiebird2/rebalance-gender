#!/usr/bin/env node
// ============================================================
// compute-scores.mjs
//
// Reads all signal tables (artist_genres, mb_tags,
// mb_collaborations, sc_follow_edges) and computes pairwise
// similarity scores for approved directory artists, writing
// the top-10 recommendations per artist into
// artist_similarity_scores.
//
// Only pairs where at least one signal exists are scored —
// pairs with no shared genres, tags, collabs, or follows are
// skipped entirely.
//
// Weights are defined in the WEIGHTS constant below. After
// running tune-weights.py, update these values and re-run
// with --force to refresh stored scores and ranks.
//
// Usage (from rebalance-gender/):
//
//   node scripts/compute-scores.mjs           # score artists without existing scores
//   node scripts/compute-scores.mjs --force   # truncate table and recompute everything
//   node scripts/compute-scores.mjs --debug   # verbose pair-level output
//   DRY_RUN=1 node scripts/compute-scores.mjs
//
// Requires .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY).
// ============================================================

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ------------------------------------------------------------
// Weights — update these after running tune-weights.py
// Must sum to 1.0
// ------------------------------------------------------------
const WEIGHTS = {
  genre:        0.20,
  mbTag:        0.20,
  mbCollab:     0.20,
  directFollow: 0.20,
  coFollow:     0.20,
}

// Sanity-check weights sum to ~1
const weightSum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0)
if (Math.abs(weightSum - 1.0) > 0.001) {
  console.error(`WEIGHTS must sum to 1.0 (currently ${weightSum.toFixed(4)})`)
  process.exit(1)
}

// ------------------------------------------------------------
// CLI / env
// ------------------------------------------------------------
const args    = process.argv.slice(2)
const DRY_RUN = process.env.DRY_RUN === '1' || args.includes('--dry-run')
const FORCE   = args.includes('--force')
const DEBUG   = args.includes('--debug')

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
// Helpers
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

// Canonical pair key: always lower UUID first
function pairKey(idA, idB) {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`
}

function pairIds(key) {
  const [a, b] = key.split('|')
  return [a, b]
}

// Jaccard similarity between two Sets
function jaccard(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const item of setA) {
    if (setB.has(item)) intersection++
  }
  return intersection / (setA.size + setB.size - intersection)
}

// ------------------------------------------------------------
// Data loading
// ------------------------------------------------------------
async function loadDirectoryArtists() {
  return fetchAllPages(from =>
    supabase
      .from('artists')
      .select('id, name')
      .eq('directory_status', 'approved')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
  )
}

async function loadArtistGenres(dirIds) {
  const rows = await fetchAllPages(from =>
    supabase
      .from('artist_genres')
      .select('artist_id, genre')
      .in('artist_id', [...dirIds])
      .order('artist_id')
      .range(from, from + PAGE_SIZE - 1)
  )
  const map = new Map()
  for (const { artist_id, genre } of rows) {
    if (!map.has(artist_id)) map.set(artist_id, new Set())
    map.get(artist_id).add(genre)
  }
  return map
}

async function loadMbTags(dirIds) {
  const rows = await fetchAllPages(from =>
    supabase
      .from('mb_tags')
      .select('artist_id, tag')
      .in('artist_id', [...dirIds])
      .order('artist_id')
      .range(from, from + PAGE_SIZE - 1)
  )
  const map = new Map()
  for (const { artist_id, tag } of rows) {
    if (!map.has(artist_id)) map.set(artist_id, new Set())
    map.get(artist_id).add(tag)
  }
  return map
}

async function loadMbCollabs(dirIds) {
  // Both artist_id_a and artist_id_b are directory artists (schema constraint
  // artist_id_a < artist_id_b means rows are already canonical)
  const rows = await fetchAllPages(from =>
    supabase
      .from('mb_collaborations')
      .select('artist_id_a, artist_id_b')
      .or(`artist_id_a.in.(${[...dirIds].join(',')}),artist_id_b.in.(${[...dirIds].join(',')})`)
      .order('artist_id_a')
      .range(from, from + PAGE_SIZE - 1)
  )
  return new Set(rows.map(r => pairKey(r.artist_id_a, r.artist_id_b)))
}

async function loadScFollowEdges(dirIds) {
  // follower_artist_id is always a directory artist; we filter followed to dir artists too
  const rows = await fetchAllPages(from =>
    supabase
      .from('sc_follow_edges')
      .select('follower_artist_id, followed_artist_id')
      .in('follower_artist_id', [...dirIds])
      .in('followed_artist_id', [...dirIds])
      .order('follower_artist_id')
      .range(from, from + PAGE_SIZE - 1)
  )

  // Direct follow edges as a Set of "follower|followed"
  const dirEdges = new Set(rows.map(r => `${r.follower_artist_id}|${r.followed_artist_id}`))

  // followersOf[artistId] = Set of directory artist IDs who follow that artist
  const followersOf = new Map()
  for (const { follower_artist_id, followed_artist_id } of rows) {
    if (!followersOf.has(followed_artist_id)) followersOf.set(followed_artist_id, new Set())
    followersOf.get(followed_artist_id).add(follower_artist_id)
  }

  return { dirEdges, followersOf }
}

// ------------------------------------------------------------
// Build the set of pairs that have at least one signal,
// and for co-follow pairs, the raw co-follow counts.
// ------------------------------------------------------------
function buildPairs(dirIds, genres, tags, collabs, dirEdges) {
  const pairs = new Set()

  // Helper: enumerate pairs within a list of IDs sharing a common attribute
  function addPairsFromIndex(index) {
    for (const [, artists] of index) {
      const arr = [...artists]
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          pairs.add(pairKey(arr[i], arr[j]))
        }
      }
    }
  }

  // Genre overlap pairs
  const genreIndex = new Map()
  for (const [id, genreSet] of genres) {
    for (const g of genreSet) {
      if (!genreIndex.has(g)) genreIndex.set(g, [])
      genreIndex.get(g).push(id)
    }
  }
  addPairsFromIndex(genreIndex)

  // MB tag overlap pairs
  const tagIndex = new Map()
  for (const [id, tagSet] of tags) {
    for (const t of tagSet) {
      if (!tagIndex.has(t)) tagIndex.set(t, [])
      tagIndex.get(t).push(id)
    }
  }
  addPairsFromIndex(tagIndex)

  // MB collaboration pairs (already canonical)
  for (const key of collabs) pairs.add(key)

  // SC direct follow pairs
  for (const edge of dirEdges) {
    const [follower, followed] = edge.split('|')
    pairs.add(pairKey(follower, followed))
  }

  // SC co-follow pairs: for each directory artist (as follower),
  // find all pairs of directory artists they follow
  const coFollowCounts = new Map()   // pairKey → count

  // Build following lists: follower → [followed dir artists]
  const followingLists = new Map()
  for (const edge of dirEdges) {
    const [follower, followed] = edge.split('|')
    if (!followingLists.has(follower)) followingLists.set(follower, [])
    followingLists.get(follower).push(followed)
  }

  for (const [, followed] of followingLists) {
    for (let i = 0; i < followed.length; i++) {
      for (let j = i + 1; j < followed.length; j++) {
        const key = pairKey(followed[i], followed[j])
        pairs.add(key)
        coFollowCounts.set(key, (coFollowCounts.get(key) ?? 0) + 1)
      }
    }
  }

  return { pairs, coFollowCounts }
}

// ------------------------------------------------------------
// Score a single pair
// ------------------------------------------------------------
function scorePair(idA, idB, genres, tags, collabs, dirEdges, coFollowCounts, followersOf) {
  const key = pairKey(idA, idB)

  const genreScore  = jaccard(genres.get(idA), genres.get(idB))
  const mbTagScore  = jaccard(tags.get(idA), tags.get(idB))
  const mbCollab    = collabs.has(key) ? 1 : 0

  const directFollow = (
    dirEdges.has(`${idA}|${idB}`) || dirEdges.has(`${idB}|${idA}`)
  ) ? 1 : 0

  // Co-follow: normalise by geometric mean of each artist's follower count
  const coCount    = coFollowCounts.get(key) ?? 0
  const followersA = followersOf.get(idA)?.size ?? 0
  const followersB = followersOf.get(idB)?.size ?? 0
  const coFollow   = (followersA > 0 && followersB > 0)
    ? coCount / Math.sqrt(followersA * followersB)
    : 0

  const total =
    WEIGHTS.genre        * genreScore +
    WEIGHTS.mbTag        * mbTagScore +
    WEIGHTS.mbCollab     * mbCollab   +
    WEIGHTS.directFollow * directFollow +
    WEIGHTS.coFollow     * coFollow

  return {
    genre_score:            round4(genreScore),
    mb_tag_score:           round4(mbTagScore),
    mb_collab_score:        round4(mbCollab),
    sc_direct_follow_score: round4(directFollow),
    sc_co_follow_score:     round4(Math.min(coFollow, 1)),  // cap at 1.0
    total_score:            round4(Math.min(total, 1)),
  }
}

function round4(n) {
  return Math.round(n * 10000) / 10000
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(`compute-scores${DRY_RUN ? ' (DRY RUN)' : ''}${FORCE ? ' (--force)' : ''}`)
  console.log(`Weights: genre=${WEIGHTS.genre} mbTag=${WEIGHTS.mbTag} mbCollab=${WEIGHTS.mbCollab} directFollow=${WEIGHTS.directFollow} coFollow=${WEIGHTS.coFollow}`)
  console.log()

  // 1. Load directory artists
  console.log('Loading directory artists…')
  const artists = await loadDirectoryArtists()
  const dirIds  = new Set(artists.map(a => a.id))
  const artistById = new Map(artists.map(a => [a.id, a]))
  console.log(`  ${artists.length} approved directory artists.`)

  // Without --force, skip artists that already have scores
  let artistsToScore = artists
  if (!FORCE) {
    const { data: existing } = await supabase
      .from('artist_similarity_scores')
      .select('source_artist_id')
    const alreadyScored = new Set((existing ?? []).map(r => r.source_artist_id))
    artistsToScore = artists.filter(a => !alreadyScored.has(a.id))
    if (alreadyScored.size) {
      console.log(`  Skipping ${alreadyScored.size} already-scored artist(s). Use --force to recompute all.`)
    }
  }

  if (!artistsToScore.length) {
    console.log('Nothing to compute.')
    return
  }

  // 2. Load signal data
  console.log('\nLoading signal data…')
  const [genres, tags, collabs, { dirEdges, followersOf }] = await Promise.all([
    loadArtistGenres(dirIds),
    loadMbTags(dirIds),
    loadMbCollabs(dirIds),
    loadScFollowEdges(dirIds),
  ])
  console.log(`  Genres:        ${[...genres.values()].reduce((n, s) => n + s.size, 0)} tag assignments across ${genres.size} artists`)
  console.log(`  MB tags:       ${[...tags.values()].reduce((n, s) => n + s.size, 0)} tag assignments across ${tags.size} artists`)
  console.log(`  MB collabs:    ${collabs.size} edges`)
  console.log(`  SC dir edges:  ${dirEdges.size} follow edges between directory artists`)

  // 3. Build pair set + co-follow counts
  console.log('\nBuilding pair set…')
  const { pairs, coFollowCounts } = buildPairs(dirIds, genres, tags, collabs, dirEdges)
  console.log(`  ${pairs.size} pairs with at least one signal.`)
  console.log(`  ${coFollowCounts.size} pairs with co-follow signal.`)

  // 4. Score all pairs and group by source artist
  console.log('\nScoring pairs…')
  const toScoreIds = new Set(artistsToScore.map(a => a.id))

  // Map: source_artist_id → [{recommended_artist_id, scores}]
  const candidatesByArtist = new Map()
  for (const id of toScoreIds) candidatesByArtist.set(id, [])

  let pairsDone = 0
  for (const key of pairs) {
    const [idA, idB] = pairIds(key)

    // Only score pairs where at least one side is in our to-score set
    const scoreForA = toScoreIds.has(idA)
    const scoreForB = toScoreIds.has(idB)
    if (!scoreForA && !scoreForB) continue

    const scores = scorePair(idA, idB, genres, tags, collabs, dirEdges, coFollowCounts, followersOf)

    if (scoreForA) {
      candidatesByArtist.get(idA).push({ recommended_artist_id: idB, ...scores })
    }
    if (scoreForB) {
      candidatesByArtist.get(idB).push({ recommended_artist_id: idA, ...scores })
    }

    pairsDone++
    if (DEBUG && pairsDone % 10000 === 0) {
      process.stdout.write(`  ${pairsDone} pairs scored…\r`)
    }
  }
  console.log(`  ${pairsDone} pairs scored.`)

  // 5. For each artist, sort by total_score and keep top 10
  console.log('\nExtracting top 10 per artist…')

  let totalWritten = 0, totalSkipped = 0

  for (const [sourceId, candidates] of candidatesByArtist) {
    const sourceName = artistById.get(sourceId)?.name ?? sourceId

    // Sort descending by total_score, take top 10
    const top10 = candidates
      .filter(c => dirIds.has(c.recommended_artist_id))  // must be approved directory artist
      .sort((a, b) => b.total_score - a.total_score)
      .slice(0, 10)

    if (!top10.length) {
      if (DEBUG) console.log(`  ${sourceName}: no candidates`)
      totalSkipped++
      continue
    }

    if (DEBUG) {
      console.log(`  ${sourceName}: top match = ${artistById.get(top10[0].recommended_artist_id)?.name} (${top10[0].total_score})`)
    }

    const rows = top10.map((c, i) => ({
      source_artist_id:       sourceId,
      recommended_artist_id:  c.recommended_artist_id,
      genre_score:            c.genre_score,
      mb_tag_score:           c.mb_tag_score,
      mb_collab_score:        c.mb_collab_score,
      sc_direct_follow_score: c.sc_direct_follow_score,
      sc_co_follow_score:     c.sc_co_follow_score,
      total_score:            c.total_score,
      rank:                   i + 1,
      computed_at:            new Date().toISOString(),
    }))

    if (!DRY_RUN) {
      const { error } = await supabase
        .from('artist_similarity_scores')
        .upsert(rows, { onConflict: 'source_artist_id,recommended_artist_id' })
      if (error) {
        console.error(`  ✗ ${sourceName}: ${error.message}`)
        continue
      }
    }

    totalWritten++
    if (totalWritten % 100 === 0) {
      console.log(`  … ${totalWritten} artists written`)
    }
  }

  console.log()
  console.log('─'.repeat(50))
  console.log(`Artists scored    : ${totalWritten}`)
  console.log(`Artists skipped   : ${totalSkipped} (no candidates)`)
  console.log(`Pairs evaluated   : ${pairsDone}`)
  if (DRY_RUN) console.log('\nDry run — no data was written.')
}

main().catch(err => {
  console.error('\nFailed:', err?.message ?? err)
  process.exit(1)
})
