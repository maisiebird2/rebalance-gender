#!/usr/bin/env node
// ============================================================
// clean-artist-names.mjs
//
// Scans every artist in the database and trims invisible Unicode
// characters and whitespace from the start and end of their name.
// Only rows whose name actually changes are updated.
//
// Safe to run at any time — reads all artists, writes only the
// rows that need fixing.
//
// Usage (from wem-directory/):
//
//   node scripts/clean-artist-names.mjs           # fix all affected artists
//   node scripts/clean-artist-names.mjs --dry-run # report without writing
//   node scripts/clean-artist-names.mjs --debug   # show hex codes for dirty names
//   DRY_RUN=1 node scripts/clean-artist-names.mjs # same as --dry-run
// ============================================================

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanArtistName } from './lib/name-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run')
const DEBUG   = process.argv.includes('--debug')

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

// Show the hex codepoints of characters in a string — useful for debugging
// invisible character issues.
function toHex(str) {
  return [...str].map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ')
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  console.log(DRY_RUN ? 'DRY RUN — no changes will be written.\n' : 'Cleaning artist names…\n')

  // Fetch all artists in pages
  const artists = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('artists')
      .select('id, name')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    artists.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  console.log(`Loaded ${artists.length} artists.`)

  // Find rows that need cleaning
  const dirty = artists
    .map(a => ({ id: a.id, original: a.name, cleaned: cleanArtistName(a.name) }))
    .filter(r => r.original !== r.cleaned)

  if (!dirty.length) {
    console.log('No artist names need cleaning.')
    return
  }

  console.log(`\nFound ${dirty.length} artist(s) with names to clean:\n`)
  for (const r of dirty) {
    const cleanedDisplay = r.cleaned.length === 0 ? '(empty after cleaning)' : r.cleaned
    console.log(`  [${r.id}]  "${r.original}"  →  "${cleanedDisplay}"`)
    if (DEBUG) {
      console.log(`    before: ${toHex(r.original)}`)
      console.log(`    after:  ${toHex(r.cleaned)}`)
    }
  }

  if (DRY_RUN) {
    console.log(`\nDry run — would update ${dirty.length} row(s).`)
    return
  }

  // Update in batches of 100
  let updated = 0
  let failed  = 0
  const BATCH = 100
  for (let i = 0; i < dirty.length; i += BATCH) {
    const batch = dirty.slice(i, i + BATCH)
    for (const r of batch) {
      const { error } = await supabase
        .from('artists')
        .update({ name: r.cleaned })
        .eq('id', r.id)
      if (error) {
        console.error(`  failed to update "${r.original}": ${error.message}`)
        failed++
      } else {
        updated++
      }
    }
  }

  console.log(`\nDone. Updated: ${updated}  Failed: ${failed}`)
}

main().catch(err => {
  console.error('\nFailed:', err?.message ?? err)
  process.exit(1)
})
