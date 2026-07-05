#!/usr/bin/env node
// ============================================================
// apply-genre-status.mjs
//
// Applies genre status changes that you make by hand in the
// genre-report.csv (or any CSV with `id`, `name`, `status`
// columns). Workflow:
//
//   1. node scripts/genre-report.mjs         # produces genre-report.csv
//   2. Open the CSV, set the `status` cell to `deleted` for every
//      genre you want to cut (or `approved` to restore one). Leave
//      the `id` column untouched — it's the key. Save.
//   3. node scripts/apply-genre-status.mjs --dry-run   # preview
//   4. node scripts/apply-genre-status.mjs             # apply
//
// It compares the CSV's status against the database and updates
// ONLY the rows that changed. As a safety check it verifies the
// CSV `name` still matches the DB name for that id, and skips (with
// a warning) any row where they differ — so a stale CSV can't
// update the wrong genre. Idempotent: re-running does nothing once
// the DB matches the CSV.
//
// status must be one of: pending | approved | deleted
// (enforced by the genres_status_check constraint).
//
// ── Usage ─────────────────────────────────────────────────
//   node scripts/apply-genre-status.mjs --dry-run
//   node scripts/apply-genre-status.mjs
//   node scripts/apply-genre-status.mjs --csv=/path/to/edited.csv
//   node scripts/apply-genre-status.mjs --dry-run --sql-out=genre-status.sql
//        Also writes an equivalent SQL migration (UPDATE … WHERE id IN …)
//        for version control / running in the Supabase SQL editor.
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── CLI ──────────────────────────────────────────────────
const args    = process.argv.slice(2)
const DRY_RUN = process.env.DRY_RUN === '1' || args.includes('--dry-run')
const csvArg  = args.find(a => a.startsWith('--csv='))
const sqlArg  = args.find(a => a.startsWith('--sql-out='))
const CSV     = csvArg ? csvArg.split('=').slice(1).join('=') : path.resolve(process.cwd(), 'genre-report.csv')
const SQL_OUT = sqlArg ? sqlArg.split('=').slice(1).join('=') : null

const VALID_STATUS = new Set(['pending', 'approved', 'deleted'])

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

// ── Minimal RFC-4180-ish CSV parser (handles quoted cells,
//    escaped quotes, commas and newlines inside quotes) ────
function parseCsv(text) {
  const rows = []
  let row = [], cell = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else inQuotes = false
      } else cell += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(cell); cell = ''
    } else if (c === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''
    } else if (c === '\r') {
      // ignore; handled by \n
    } else cell += c
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function sqlQuote(s) { return `'${String(s).replace(/'/g, "''")}'` }

async function main() {
  console.log(DRY_RUN ? '── DRY RUN (no changes) ──' : '── LIVE RUN ──')

  if (!fs.existsSync(CSV)) {
    console.error(`CSV not found: ${CSV}`)
    process.exit(1)
  }

  const table = parseCsv(fs.readFileSync(CSV, 'utf8')).filter(r => r.length && r.some(c => c !== ''))
  if (table.length < 2) { console.error('CSV has no data rows.'); process.exit(1) }

  const header = table[0].map(h => h.trim())
  const iId = header.indexOf('id')
  const iName = header.indexOf('name')
  const iStatus = header.indexOf('status')
  if (iId < 0 || iName < 0 || iStatus < 0) {
    console.error('CSV must have id, name and status columns.')
    process.exit(1)
  }

  // Parse desired state from CSV.
  const desired = new Map()   // id -> { name, status }
  let badStatus = 0
  for (const r of table.slice(1)) {
    const id = parseInt((r[iId] ?? '').trim(), 10)
    if (!Number.isInteger(id)) continue
    const status = (r[iStatus] ?? '').trim().toLowerCase()
    if (!VALID_STATUS.has(status)) { badStatus++; continue }
    desired.set(id, { name: (r[iName] ?? '').trim(), status })
  }
  if (badStatus) console.log(`Skipped ${badStatus} row(s) with an invalid status value.`)

  // Current DB state.
  const dbGenres = await fetchAllPages(() => supabase.from('genres').select('id, name, status'))
  const dbById = new Map(dbGenres.map(g => [g.id, g]))

  // Diff.
  const changes = []     // { id, name, from, to }
  const mismatches = []  // { id, csvName, dbName }
  const missing = []     // ids in CSV not in DB
  for (const [id, want] of desired) {
    const db = dbById.get(id)
    if (!db) { missing.push(id); continue }
    if (want.name && db.name.trim() !== want.name) {
      mismatches.push({ id, csvName: want.name, dbName: db.name }); continue
    }
    if (db.status !== want.status) changes.push({ id, name: db.name, from: db.status, to: want.status })
  }

  if (mismatches.length) {
    console.log(`\n⚠ ${mismatches.length} row(s) skipped — CSV name doesn't match DB (stale CSV?):`)
    for (const m of mismatches.slice(0, 20)) console.log(`    id ${m.id}: CSV "${m.csvName}" vs DB "${m.dbName}"`)
    if (mismatches.length > 20) console.log(`    … and ${mismatches.length - 20} more`)
  }
  if (missing.length) console.log(`\n⚠ ${missing.length} CSV id(s) not found in DB (ignored).`)

  if (changes.length === 0) {
    console.log('\nNo status changes to apply — DB already matches the CSV.')
    return
  }

  // Report grouped by target status.
  const byTarget = {}
  for (const c of changes) (byTarget[c.to] = byTarget[c.to] || []).push(c)
  console.log(`\n${changes.length} status change(s):`)
  for (const to of Object.keys(byTarget).sort()) {
    const list = byTarget[to]
    console.log(`  → ${to}: ${list.length}`)
    for (const c of list.slice(0, 40)) console.log(`      "${c.name}" (${c.from} → ${to})`)
    if (list.length > 40) console.log(`      … and ${list.length - 40} more`)
  }

  // Optional SQL migration output.
  if (SQL_OUT) {
    const stmts = ['-- Genre status changes generated by apply-genre-status.mjs', `-- ${new Date().toISOString()}`, '']
    for (const to of Object.keys(byTarget).sort()) {
      const ids = byTarget[to].map(c => c.id).sort((a, b) => a - b)
      stmts.push(`UPDATE public.genres SET status = ${sqlQuote(to)} WHERE id IN (${ids.join(', ')});`)
    }
    fs.writeFileSync(SQL_OUT, stmts.join('\n') + '\n')
    console.log(`\nWrote SQL migration: ${SQL_OUT}`)
  }

  if (DRY_RUN) {
    console.log('\nDry run — nothing changed. Re-run without --dry-run to apply.')
    return
  }

  // Apply, batched per target status.
  for (const to of Object.keys(byTarget)) {
    const ids = byTarget[to].map(c => c.id)
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200)
      const { error } = await supabase.from('genres').update({ status: to }).in('id', batch)
      if (error) console.error(`  update → ${to} failed: ${error.message}`)
    }
  }
  console.log(`\nDone. Applied ${changes.length} status change(s).`)
}

const isMainModule = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMainModule) {
  main().catch(err => { console.error('\nFailed:', err?.message ?? err); process.exit(1) })
}
