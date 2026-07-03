#!/usr/bin/env node
// ============================================================
// harvest-genres-mb.mjs
//
// Copies rows from the mb_tags table (populated by
// enrich-musicbrainz.mjs) into the artist_harvested_genres
// staging table, with source_platform = 'musicbrainz'.
//
// mb_tags is the recommendation engine's store for MusicBrainz
// folksonomy tags. This script does not call the MusicBrainz API
// directly — run enrich-musicbrainz.mjs first to populate mb_tags,
// then run this script to pull those tags into the genre pipeline.
//
// Re-running is safe: the unique constraint on
// (artist_id, source_platform, raw_tag) means existing rows are
// left untouched (ON CONFLICT DO NOTHING).
//
// Usage (from rebalance-gender/):
//
//   node scripts/harvest-genres-mb.mjs
//   node scripts/harvest-genres-mb.mjs --limit=100
//   node scripts/harvest-genres-mb.mjs --name="nina kraviz"
//   node scripts/harvest-genres-mb.mjs --debug
//   DRY_RUN=1 node scripts/harvest-genres-mb.mjs
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local.
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
const DEBUG   = args.includes('--debug')

const limitArg    = args.find(a => a.startsWith('--limit='))
const nameArg     = args.find(a => a.startsWith('--name='))
const OPT_LIMIT   = limitArg ? parseInt(limitArg.split('=')[1], 10) : null
const OPT_NAME    = nameArg  ? nameArg.split('=').slice(1).join('=').toLowerCase() : null

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
// Main
// ------------------------------------------------------------
async function main() {
  console.log(`harvest-genres-mb${DRY_RUN ? ' (DRY RUN)' : ''}`)
  console.log()

  // 1. Load mb_tags, optionally filtered by artist name.
  console.log('Loading mb_tags…')
  const mbTags = await fetchAllPages((from, to) => {
    let q = supabase
      .from('mb_tags')
      .select(OPT_NAME
        ? 'artist_id, tag, artists!inner(name)'
        : 'artist_id, tag')
      .order('artist_id')
      .order('tag')
      .range(from, to)
    if (OPT_NAME) q = q.ilike('artists.name', `%${OPT_NAME}%`)
    return q
  })

  console.log(`  Found ${mbTags.length} mb_tags row(s).`)

  if (mbTags.length === 0) {
    console.log('\nNothing to copy. Run enrich-musicbrainz.mjs first to populate mb_tags.')
    return
  }

  // 2. Check which (artist_id, raw_tag) pairs already exist in
  //    artist_harvested_genres to report on skips without relying
  //    solely on ON CONFLICT DO NOTHING (which gives no row count).
  console.log('Checking existing artist_harvested_genres rows…')
  const existing = await fetchAllPages((from, to) =>
    supabase
      .from('artist_harvested_genres')
      .select('artist_id, raw_tag')
      .eq('source_platform', 'musicbrainz')
      .range(from, to)
  )
  const existingSet = new Set(existing.map(r => `${r.artist_id}|${r.raw_tag}`))
  console.log(`  Already in staging: ${existingSet.size} MB genre row(s).`)

  // 3. Build the rows to insert (skip already-present pairs).
  let toInsert = mbTags
    .filter(r => !existingSet.has(`${r.artist_id}|${r.tag}`))
    .map(r => ({
      artist_id:       r.artist_id,
      source_platform: 'musicbrainz',
      raw_tag:         r.tag,
      tag_count:       null,  // mb_tags doesn't store the vote count
    }))

  if (OPT_LIMIT && toInsert.length > OPT_LIMIT) {
    toInsert = toInsert.slice(0, OPT_LIMIT)
    console.log(`  Applying --limit: processing first ${OPT_LIMIT} new row(s).`)
  }

  console.log(`\n${toInsert.length} new row(s) to copy into artist_harvested_genres.`)
  if (toInsert.length === 0) {
    console.log('All mb_tags rows are already in the staging table.')
    return
  }

  if (DEBUG) {
    for (const r of toInsert.slice(0, 20)) {
      console.log(`  + ${r.artist_id}  "${r.raw_tag}"`)
    }
    if (toInsert.length > 20) console.log(`  … and ${toInsert.length - 20} more`)
  }

  if (DRY_RUN) {
    console.log('\nDry run — no data written.')
    return
  }

  // 4. Insert in batches of 500.
  let inserted = 0
  let errors   = 0
  for (const batch of chunk(toInsert, 500)) {
    const { error } = await supabase
      .from('artist_harvested_genres')
      .insert(batch)
    if (error) {
      console.error(`  Batch insert failed: ${error.message}`)
      errors++
    } else {
      inserted += batch.length
    }
  }

  console.log()
  console.log('─'.repeat(50))
  console.log(`Rows inserted : ${inserted}`)
  console.log(`Batch errors  : ${errors}`)
}

main().catch(err => {
  console.error('\nFailed:', err?.message ?? err)
  process.exit(1)
})
