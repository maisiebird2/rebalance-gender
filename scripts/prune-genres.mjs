#!/usr/bin/env node
// ============================================================
// prune-genres.mjs
//
// Pares the genre vocabulary down toward a manageable size using
// two phases (run rollup BEFORE cut so cut-away artists are first
// preserved on a parent genre):
//
//   PHASE 1 — ROLLUP
//     Merge each subgenre in ROLLUP into its parent genre. This
//     reuses the same repoint-then-delete mechanics as
//     dedupe-genres-by-alias.mjs: artist_genres and
//     artist_harvested_genres are repointed to the parent, then
//     the emptied subgenre row is deleted. Artists linked only to
//     the subgenre keep a (broader) tag.
//
//   PHASE 2 — CUT
//     Any genre whose artist_count is below --threshold (default 3)
//     is "cut": by default its status is set to 'deleted' (hidden
//     from the directory but fully reversible — the genre row and
//     its artist links stay in place). Use --hard to instead delete
//     the genre rows outright (artist_genres cascades away).
//
// Reversibility: the default cut (status='deleted') can be undone
// by flipping status back to 'approved'. --hard is destructive.
//
// ── Usage ─────────────────────────────────────────────────
//   node scripts/prune-genres.mjs --dry-run
//        Show the full rollup + cut plan, change nothing.
//
//   node scripts/prune-genres.mjs --dry-run --threshold=2
//        Preview with a different cut threshold.
//
//   node scripts/prune-genres.mjs --rollup-only          # phase 1 only
//   node scripts/prune-genres.mjs --cut-only --threshold=3
//   node scripts/prune-genres.mjs --threshold=3          # both phases
//   node scripts/prune-genres.mjs --threshold=3 --hard   # cut = hard delete
//
// Workflow: run genre-report.mjs first to see the artist-count
// distribution, fill in the ROLLUP map below from genre-report.csv,
// then --dry-run this until the resulting count looks right, then
// run for real.
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================
// ROLLUP MAP  —  subgenre name  →  parent genre name
//
// Case-insensitive on the left. The parent should be a genre you
// intend to KEEP. If the parent doesn't exist yet it will be
// created. Add entries by scanning genre-report.csv for narrow /
// low-count genres that clearly belong under a broader one.
//
// Seeded empty on purpose — rollup choices are editorial and
// depend on your actual genre list. A few illustrative examples
// are commented out below; delete or replace them.
// ============================================================
const ROLLUP = new Map([
  // ['liquid drum & bass',   'drum & bass'],
  // ['neurofunk',            'drum & bass'],
  // ['deep house',           'house'],
  // ['tech house',           'house'],
  // ['melodic techno',       'techno'],
  // ['dark ambient',         'ambient'],
])

// ── CLI ──────────────────────────────────────────────────
const args        = process.argv.slice(2)
const DRY_RUN     = process.env.DRY_RUN === '1' || args.includes('--dry-run')
const ROLLUP_ONLY = args.includes('--rollup-only')
const CUT_ONLY    = args.includes('--cut-only')
const HARD        = args.includes('--hard')
const thrArg      = args.find(a => a.startsWith('--threshold='))
const THRESHOLD   = thrArg ? parseInt(thrArg.split('=')[1], 10) : 3

if (ROLLUP_ONLY && CUT_ONLY) {
  console.error('Pass at most one of --rollup-only / --cut-only.')
  process.exit(1)
}
const doRollup = !CUT_ONLY
const doCut    = !ROLLUP_ONLY

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

// ── Pagination ───────────────────────────────────────────
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

// ── Merge one genre's links into another, then delete the source ──
// Mirrors dedupe-genres-by-alias.mjs. `links` is the in-memory list
// of {artist_id, genre_id} so we can compute conflicts without extra
// round-trips; it is kept in sync as we go.
async function mergeGenreInto(fromId, toId, links) {
  const toArtists = new Set(links.filter(r => r.genre_id === toId).map(r => r.artist_id))
  const fromRows  = links.filter(r => r.genre_id === fromId)

  for (const row of fromRows) {
    if (toArtists.has(row.artist_id)) {
      const { error } = await supabase.from('artist_genres')
        .delete().eq('artist_id', row.artist_id).eq('genre_id', fromId)
      if (error) { console.error(`  delete link failed: ${error.message}`); continue }
    } else {
      const { error } = await supabase.from('artist_genres')
        .update({ genre_id: toId }).eq('artist_id', row.artist_id).eq('genre_id', fromId)
      if (error) { console.error(`  remap link failed: ${error.message}`); continue }
      toArtists.add(row.artist_id)
    }
    row.genre_id = toId  // keep in-memory model consistent
  }

  const ahgRows = await fetchAllPages(() =>
    supabase.from('artist_harvested_genres').select('id').eq('genre_id', fromId))
  for (const r of ahgRows) {
    const { error } = await supabase.from('artist_harvested_genres')
      .update({ genre_id: toId }).eq('id', r.id)
    if (error) console.error(`  remap ahg ${r.id} failed: ${error.message}`)
  }

  const { error: delErr } = await supabase.from('genres').delete().eq('id', fromId)
  if (delErr) console.error(`  delete genre ${fromId} failed: ${delErr.message}`)
}

async function findOrCreateGenre(name, genresByLcName) {
  const existing = genresByLcName.get(name.toLowerCase())
  if (existing) return existing
  const { data, error } = await supabase.from('genres')
    .insert({ name, status: 'approved' }).select('id, name, status').single()
  if (error) throw error
  const rec = { id: data.id, name: data.name, status: data.status }
  genresByLcName.set(name.toLowerCase(), rec)
  return rec
}

async function main() {
  console.log(DRY_RUN ? '── DRY RUN (no changes) ──' : '── LIVE RUN ──')
  console.log(`Phases: ${doRollup ? 'rollup ' : ''}${doCut ? `cut(<${THRESHOLD}${HARD ? ', hard' : ''})` : ''}`.trim())

  const genres = await fetchAllPages(() => supabase.from('genres').select('id, name, status'))
  const links  = await fetchAllPages(() => supabase.from('artist_genres').select('artist_id, genre_id'))

  const genresByLcName = new Map(genres.map(g => [g.name.toLowerCase(), g]))
  const countOf = id => links.filter(r => r.genre_id === id).length

  console.log(`\nStarting genre count: ${genres.length}`)

  // ── PHASE 1: ROLLUP ──
  let rolled = 0
  if (doRollup) {
    const plan = []
    for (const [sub, parent] of ROLLUP) {
      const subRec = genresByLcName.get(sub.toLowerCase())
      if (!subRec) continue                             // subgenre not present
      if (sub.toLowerCase() === parent.toLowerCase()) continue
      plan.push({ subRec, parentName: parent })
    }

    if (plan.length === 0) {
      console.log('\nRollup: nothing to do (ROLLUP map empty or no matches).')
    } else {
      console.log(`\nRollup — ${plan.length} subgenre(s) → parent:`)
      for (const { subRec, parentName } of plan) {
        console.log(`  "${subRec.name}" (${countOf(subRec.id)} artists) → "${parentName}"`)
      }
      if (!DRY_RUN) {
        for (const { subRec, parentName } of plan) {
          const parentRec = await findOrCreateGenre(parentName, genresByLcName)
          if (parentRec.id === subRec.id) continue
          await mergeGenreInto(subRec.id, parentRec.id, links)
          genresByLcName.delete(subRec.name.toLowerCase())
          rolled++
        }
      }
    }
  }

  // ── PHASE 2: CUT ──
  if (doCut) {
    // Recompute from the (possibly mutated) in-memory link list.
    const remaining = [...genresByLcName.values()]
    const toCut = remaining.filter(g =>
      g.status !== 'deleted' && countOf(g.id) < THRESHOLD)

    console.log(`\nCut — ${toCut.length} genre(s) under ${THRESHOLD} artist(s) ` +
      `will be ${HARD ? 'hard-deleted' : "set status='deleted'"}:`)
    // Show a sample so the console stays readable.
    for (const g of toCut.slice(0, 40)) console.log(`  "${g.name}" (${countOf(g.id)} artists)`)
    if (toCut.length > 40) console.log(`  … and ${toCut.length - 40} more`)

    // Genres still visible (approved/pending, enough artists) after the cut.
    const visibleAfter = remaining.filter(g =>
      g.status !== 'deleted' && countOf(g.id) >= THRESHOLD).length

    if (!DRY_RUN && toCut.length) {
      const ids = toCut.map(g => g.id)
      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200)
        if (HARD) {
          const { error } = await supabase.from('genres').delete().in('id', batch)
          if (error) console.error(`  hard-delete batch failed: ${error.message}`)
        } else {
          const { error } = await supabase.from('genres')
            .update({ status: 'deleted' }).in('id', batch)
          if (error) console.error(`  status-cut batch failed: ${error.message}`)
        }
      }
    }
    console.log(`\nApprox. visible genres after cut: ${visibleAfter}`)
  }

  if (DRY_RUN) {
    console.log('\nDry run — nothing changed. Re-run without --dry-run to apply.')
  } else {
    console.log(`\nDone. Rolled up ${rolled} subgenre(s).`)
  }
}

const isMainModule = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMainModule) {
  main().catch(err => { console.error('\nFailed:', err?.message ?? err); process.exit(1) })
}
