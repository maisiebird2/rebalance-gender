#!/usr/bin/env node
// ============================================================
// dedupe-genres-by-alias.mjs
//
// Retroactively merges duplicate genre rows that already exist in
// the `genres` table but resolve to the same canonical name through
// the alias vocabulary in integrate-harvested-genres.mjs.
//
// Why this exists:
//   integrate-harvested-genres.mjs already collapses raw tags to a
//   canonical name at harvest time (GENRE_ALIASES), and its built-in
//   deduplicateGenres() pass merges genres whose *names* normalise to
//   the same string (accents / hyphens). But it does NOT merge genres
//   that only become equal *through the alias map* — e.g.
//
//       "drum & bass", "drum u bass", "drum'n'bass", "drumandbass"
//
//   These differ in their connective (& / u / 'n' / and), so their
//   normalised names are all different; only GENRE_ALIASES knows they
//   are the same genre. Rows created before an alias was added (or
//   inserted by some other path) therefore linger as duplicates.
//
//   This script groups existing genre rows by their alias-RESOLVED
//   canonical name and merges each group down to one row, reusing the
//   same repoint-then-delete logic as deduplicateGenres().
//
// What it does per duplicate group:
//   1. Pick the winner: the row whose name already equals the
//      canonical name wins; otherwise the row with the most artist
//      links wins; ties break to the lowest id.
//   2. If the winner's name isn't the canonical spelling, rename it
//      (safe: a row already named canonically would have won instead).
//   3. Repoint artist_genres from each loser to the winner, deleting
//      rows where the winner is already linked to that artist (the
//      (artist_id, genre_id) primary key forbids duplicates).
//   4. Repoint artist_harvested_genres.genre_id.
//   5. Delete the loser genre rows.
//
// Safe to re-run. Idempotent once groups are collapsed.
//
// ── Usage ─────────────────────────────────────────────────
//   node scripts/dedupe-genres-by-alias.mjs --dry-run
//        Show every merge that would happen, change nothing.
//
//   node scripts/dedupe-genres-by-alias.mjs --dry-run --only="drum & bass"
//        Restrict to canonical names containing the substring.
//        (case-insensitive). Great for doing one genre at a time.
//
//   node scripts/dedupe-genres-by-alias.mjs --only="drum & bass"
//        Actually perform the drum & bass merge.
//
//   node scripts/dedupe-genres-by-alias.mjs
//        Merge every alias-collapsible duplicate group.
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in
// .env.local (same as the other scripts).
// ============================================================

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Reuse the single source of truth for the genre vocabulary.
import { normaliseTag, normalizeForLookup } from './integrate-harvested-genres.mjs'

// ------------------------------------------------------------
// CLI
// ------------------------------------------------------------
const args    = process.argv.slice(2)
const DRY_RUN = process.env.DRY_RUN === '1' || args.includes('--dry-run')
const onlyArg = args.find(a => a.startsWith('--only='))
const ONLY    = onlyArg ? onlyArg.split('=').slice(1).join('=').toLowerCase().trim() : null

// ------------------------------------------------------------
// Load .env.local (mirror of the loader in the other scripts)
// ------------------------------------------------------------
function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (!fs.existsSync(envPath)) return
  const text = fs.readFileSync(envPath, 'utf8')
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
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
// Pagination helper (Supabase caps a single select at 1000 rows)
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// Resolve a genre name to its canonical grouping key.
// Returns { canonical, key, skip }.
//   canonical – the alias-resolved display name (null if broad tag)
//   key       – normalised grouping key used to bucket duplicates
//   skip      – true if the name matches a BROAD_TAGS entry
// ------------------------------------------------------------
function resolveGroup(name) {
  const { canonical, skip } = normaliseTag(name)
  if (skip || !canonical) return { canonical: null, key: null, skip: true }
  return { canonical, key: normalizeForLookup(canonical), skip: false }
}

// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? '── DRY RUN (no changes) ──' : '── LIVE RUN ──')
  if (ONLY) console.log(`Filter: canonical name contains "${ONLY}"`)

  // 1. Load everything we need.
  const allGenres = await fetchAllPages(() =>
    supabase.from('genres').select('id, name, status'))
  const allLinks = await fetchAllPages(() =>
    supabase.from('artist_genres').select('artist_id, genre_id'))

  const countByGenre = new Map()
  for (const row of allLinks) {
    countByGenre.set(row.genre_id, (countByGenre.get(row.genre_id) ?? 0) + 1)
  }

  // 2. Bucket genres by alias-resolved canonical key.
  const groups = new Map()   // key -> { canonical, members: [genre] }
  const broadTagGenres = []
  for (const g of allGenres) {
    const { canonical, key, skip } = resolveGroup(g.name)
    if (skip) { broadTagGenres.push(g); continue }
    if (!groups.has(key)) groups.set(key, { canonical, members: [] })
    groups.get(key).members.push(g)
  }

  // 3. Keep only groups that actually contain duplicates, applying --only.
  const mergeable = []
  for (const { canonical, members } of groups.values()) {
    if (members.length <= 1) continue
    if (ONLY && !canonical.toLowerCase().includes(ONLY)) continue

    // Winner: exact canonical-name match first, then most links, then lowest id.
    members.sort((a, b) => {
      const aCanon = a.name.toLowerCase() === canonical.toLowerCase() ? 1 : 0
      const bCanon = b.name.toLowerCase() === canonical.toLowerCase() ? 1 : 0
      if (aCanon !== bCanon) return bCanon - aCanon
      const diff = (countByGenre.get(b.id) ?? 0) - (countByGenre.get(a.id) ?? 0)
      return diff !== 0 ? diff : a.id - b.id
    })
    mergeable.push({ canonical, winner: members[0], losers: members.slice(1) })
  }

  if (broadTagGenres.length) {
    console.log(`\nNote: ${broadTagGenres.length} existing genre row(s) match BROAD_TAGS ` +
      `and were left untouched (they should probably be removed separately):`)
    for (const g of broadTagGenres) console.log(`    • "${g.name}" (id ${g.id})`)
  }

  if (mergeable.length === 0) {
    console.log('\nNo alias-collapsible duplicate groups found.')
    return
  }

  // 4. Report.
  console.log(`\n${mergeable.length} duplicate group(s) to merge:\n`)
  for (const { canonical, winner, losers } of mergeable) {
    const w = `"${winner.name}" (id ${winner.id}, ${countByGenre.get(winner.id) ?? 0} links)`
    const rename = winner.name.toLowerCase() === canonical.toLowerCase()
      ? '' : ` → will rename to "${canonical}"`
    console.log(`  keep ${w}${rename}`)
    for (const l of losers) {
      console.log(`    merge "${l.name}" (id ${l.id}, ${countByGenre.get(l.id) ?? 0} links)`)
    }
  }

  if (DRY_RUN) {
    console.log('\nDry run — nothing changed. Re-run without --dry-run to apply.')
    return
  }

  // 5. Apply each merge.
  let mergedGroups = 0, removedGenres = 0, remappedLinks = 0, deletedLinks = 0
  for (const { canonical, winner, losers } of mergeable) {
    const winnerLinked = new Set(
      allLinks.filter(r => r.genre_id === winner.id).map(r => r.artist_id))

    for (const loser of losers) {
      const loserRows = allLinks.filter(r => r.genre_id === loser.id)
      for (const row of loserRows) {
        if (winnerLinked.has(row.artist_id)) {
          // Winner already linked to this artist — drop the duplicate link.
          const { error } = await supabase.from('artist_genres')
            .delete().eq('artist_id', row.artist_id).eq('genre_id', loser.id)
          if (error) { console.error(`  delete link failed: ${error.message}`); continue }
          deletedLinks++
        } else {
          const { error } = await supabase.from('artist_genres')
            .update({ genre_id: winner.id })
            .eq('artist_id', row.artist_id).eq('genre_id', loser.id)
          if (error) { console.error(`  remap link failed: ${error.message}`); continue }
          winnerLinked.add(row.artist_id)
          remappedLinks++
        }
      }

      // Repoint harvested rows for this loser.
      const ahgRows = await fetchAllPages(() =>
        supabase.from('artist_harvested_genres').select('id').eq('genre_id', loser.id))
      for (const r of ahgRows) {
        const { error } = await supabase.from('artist_harvested_genres')
          .update({ genre_id: winner.id }).eq('id', r.id)
        if (error) console.error(`  remap ahg ${r.id} failed: ${error.message}`)
      }
    }

    // Rename the winner to the canonical spelling if needed.
    if (winner.name.toLowerCase() !== canonical.toLowerCase()) {
      const { error } = await supabase.from('genres')
        .update({ name: canonical }).eq('id', winner.id)
      if (error) console.error(`  rename winner ${winner.id} failed: ${error.message}`)
    }

    // Delete the loser genre rows.
    const loserIds = losers.map(l => l.id)
    const { error: delErr } = await supabase.from('genres').delete().in('id', loserIds)
    if (delErr) { console.error(`  delete genres failed: ${delErr.message}`); continue }

    mergedGroups++
    removedGenres += loserIds.length
  }

  console.log(`\nDone. Merged ${mergedGroups} group(s): removed ${removedGenres} duplicate ` +
    `genre row(s), remapped ${remappedLinks} artist link(s), deleted ${deletedLinks} ` +
    `redundant link(s).`)
}

const isMainModule = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMainModule) {
  main().catch(err => {
    console.error('\nFailed:', err?.message ?? err)
    process.exit(1)
  })
}
