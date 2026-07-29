#!/usr/bin/env node
// ============================================================
// prune-genres.mjs
//
// Pares the genre vocabulary down toward a manageable size by
// cutting the long tail:
//
//   Any genre whose artist_count is below --threshold (default 3)
//   is "cut": by default its status is set to 'deleted' (hidden
//   from the directory but fully reversible — the genre row and
//   its artist links stay in place). Use --hard to instead delete
//   the genre rows outright (artist_genres cascades away).
//
// Reversibility: the default cut (status='deleted') can be undone
// by flipping status back to 'approved'. --hard is destructive.
//
// (This script used to have a hard-coded ROLLUP map merging
// subgenres into parents before the cut. It was removed — genre
// transformations are no longer hard-coded in scripts; see
// scripts/GENRE_CONFIDENCE.md for where a parent/child system
// would live if one is built.)
//
// ── Usage ─────────────────────────────────────────────────
//   node scripts/prune-genres.mjs --dry-run
//        Show the full cut plan, change nothing.
//
//   node scripts/prune-genres.mjs --dry-run --threshold=2
//        Preview with a different cut threshold.
//
//   node scripts/prune-genres.mjs --threshold=3
//   node scripts/prune-genres.mjs --threshold=3 --hard   # cut = hard delete
//
// Workflow: run genre-report.mjs first to see the artist-count
// distribution, then --dry-run this until the resulting count
// looks right, then run for real.
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

// ── CLI ──────────────────────────────────────────────────
const args        = process.argv.slice(2)
const DRY_RUN     = process.env.DRY_RUN === '1' || args.includes('--dry-run')
const HARD        = args.includes('--hard')
const thrArg      = args.find(a => a.startsWith('--threshold='))
const THRESHOLD   = thrArg ? parseInt(thrArg.split('=')[1], 10) : 3

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

async function main() {
  console.log(DRY_RUN ? '── DRY RUN (no changes) ──' : '── LIVE RUN ──')
  console.log(`Cut: genres under ${THRESHOLD} artist(s)${HARD ? ', hard delete' : ''}`)

  const genres = await fetchAllPages(() => supabase.from('genres').select('id, name, status'))
  const links  = await fetchAllPages(() => supabase.from('artist_genres').select('artist_id, genre_id'))

  const countOf = id => links.filter(r => r.genre_id === id).length

  console.log(`\nStarting genre count: ${genres.length}`)

  const toCut = genres.filter(g =>
    g.status !== 'deleted' && countOf(g.id) < THRESHOLD)

  console.log(`\nCut — ${toCut.length} genre(s) under ${THRESHOLD} artist(s) ` +
    `will be ${HARD ? 'hard-deleted' : "set status='deleted'"}:`)
  // Show a sample so the console stays readable.
  for (const g of toCut.slice(0, 40)) console.log(`  "${g.name}" (${countOf(g.id)} artists)`)
  if (toCut.length > 40) console.log(`  … and ${toCut.length - 40} more`)

  // Genres still visible (approved/pending, enough artists) after the cut.
  const visibleAfter = genres.filter(g =>
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

  if (DRY_RUN) {
    console.log('\nDry run — nothing changed. Re-run without --dry-run to apply.')
  } else {
    console.log('\nDone.')
  }
}

const isMainModule = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMainModule) {
  main().catch(err => { console.error('\nFailed:', err?.message ?? err); process.exit(1) })
}
