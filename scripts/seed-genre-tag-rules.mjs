#!/usr/bin/env node
// ============================================================
// seed-genre-tag-rules.mjs
//
// One-time seed (safe to re-run) for the genre_tag_rules table —
// the DB home of the genre normalisation vocabulary that used to
// be hard-coded in integrate-harvested-genres.mjs (GENRE_ALIASES,
// BROAD_TAGS, WORD_FIXES). The rows below are a frozen copy of
// those constants as of the migration; after seeding, the table
// (edited via /admin/settings or SQL) is the single source of
// truth and this file is only history.
//
// Upserts with ignoreDuplicates on (kind, raw_tag), so re-running
// never clobbers rows you have since edited or deleted-and-
// re-added in the DB — it only fills in whatever is missing.
//
// Prerequisite: run supabase_migration_genre_tag_rules.sql first.
//
// ── Usage ─────────────────────────────────────────────────
//   node scripts/seed-genre-tag-rules.mjs
//   DRY_RUN=1 node scripts/seed-genre-tag-rules.mjs
//
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.local.
// ============================================================

// FIRST import: registers the HTTP/1.1-only dispatcher process-wide
// before anything else can fetch — see that module for why.
import "./lib/http-dispatcher.mjs";
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'

const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run')

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

// ── The frozen vocabulary ────────────────────────────────
// kind: 'alias' (raw_tag → canonical), 'discard' (canonical null),
// 'word_fix' (word → replacement, applied before alias lookup).
const RULES = [
  {"kind":"alias","raw_tag":"drum and bass","canonical":"drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"d&b","canonical":"drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"dnb","canonical":"drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"drum n bass","canonical":"drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"drum 'n' bass","canonical":"drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"drum n' bass","canonical":"drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"drum'n'bass","canonical":"drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"drumandbass","canonical":"drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"drum u bass","canonical":"drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"liquid drum and bass","canonical":"liquid drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"liquid d&b","canonical":"liquid drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"liquid dnb","canonical":"liquid drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"liquid drum n bass","canonical":"liquid drum & bass","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"atmospheric dnb","canonical":"atmospheric d&b","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"atmospheric drum and bass","canonical":"atmospheric d&b","note":"Drum & Bass"},
  {"kind":"alias","raw_tag":"dub step","canonical":"dubstep","note":"Dubstep"},
  {"kind":"alias","raw_tag":"uk garage","canonical":"UK garage","note":"UK Garage"},
  {"kind":"alias","raw_tag":"u.k. garage","canonical":"UK garage","note":"UK Garage"},
  {"kind":"alias","raw_tag":"2 step","canonical":"2-step garage","note":"UK Garage"},
  {"kind":"alias","raw_tag":"2-step","canonical":"2-step garage","note":"UK Garage"},
  {"kind":"alias","raw_tag":"2step","canonical":"2-step garage","note":"UK Garage"},
  {"kind":"alias","raw_tag":"two step","canonical":"2-step garage","note":"UK Garage"},
  {"kind":"alias","raw_tag":"two-step","canonical":"2-step garage","note":"UK Garage"},
  {"kind":"alias","raw_tag":"two step garage","canonical":"2-step garage","note":"UK Garage"},
  {"kind":"alias","raw_tag":"electronic body music","canonical":"EBM","note":"EBM / Industrial"},
  {"kind":"alias","raw_tag":"e.b.m.","canonical":"EBM","note":"EBM / Industrial"},
  {"kind":"alias","raw_tag":"ebm","canonical":"EBM","note":"EBM / Industrial"},
  {"kind":"alias","raw_tag":"industrial electronic","canonical":"industrial","note":"EBM / Industrial"},
  {"kind":"alias","raw_tag":"industrial music","canonical":"industrial","note":"EBM / Industrial"},
  {"kind":"alias","raw_tag":"industrialtechno","canonical":"industrial techno","note":"EBM / Industrial"},
  {"kind":"alias","raw_tag":"technoese","canonical":"techno","note":"Techno variants (keep as distinct genres)"},
  {"kind":"alias","raw_tag":"technöse","canonical":"techno","note":"Techno variants (keep as distinct genres)"},
  {"kind":"alias","raw_tag":"minimal","canonical":"minimal techno","note":"Techno variants (keep as distinct genres)"},
  {"kind":"alias","raw_tag":"micro techno","canonical":"minimal techno","note":"Techno variants (keep as distinct genres)"},
  {"kind":"alias","raw_tag":"tecno","canonical":"techno","note":"Techno variants (keep as distinct genres)"},
  {"kind":"alias","raw_tag":"fast-paced techno","canonical":"fast techno","note":"Techno variants (keep as distinct genres)"},
  {"kind":"alias","raw_tag":"freetekno","canonical":"tekno","note":"Tekno"},
  {"kind":"alias","raw_tag":"hardtek","canonical":"tekno","note":"Tekno"},
  {"kind":"alias","raw_tag":"hard tekno","canonical":"tekno","note":"Tekno"},
  {"kind":"alias","raw_tag":"prog trance","canonical":"progressive trance","note":"Trance"},
  {"kind":"alias","raw_tag":"psy trance","canonical":"psytrance","note":"Psychedelic"},
  {"kind":"alias","raw_tag":"psy-trance","canonical":"psytrance","note":"Psychedelic"},
  {"kind":"alias","raw_tag":"psychedelic trance","canonical":"psytrance","note":"Psychedelic"},
  {"kind":"alias","raw_tag":"psycadelic techno","canonical":"psy techno","note":"Psychedelic"},
  {"kind":"alias","raw_tag":"breaks","canonical":"breakbeat","note":"Breakbeat"},
  {"kind":"alias","raw_tag":"breakbeats","canonical":"breakbeat","note":"Breakbeat"},
  {"kind":"alias","raw_tag":"break beat","canonical":"breakbeat","note":"Breakbeat"},
  {"kind":"alias","raw_tag":"break-beat","canonical":"breakbeat","note":"Breakbeat"},
  {"kind":"alias","raw_tag":"nu breaks","canonical":"nu-breaks","note":"Breakbeat"},
  {"kind":"alias","raw_tag":"nu break","canonical":"nu-breaks","note":"Breakbeat"},
  {"kind":"alias","raw_tag":"junglist","canonical":"jungle","note":"Jungle"},
  {"kind":"alias","raw_tag":"jungle music","canonical":"jungle","note":"Jungle"},
  {"kind":"alias","raw_tag":"uk grime","canonical":"grime","note":"Grime"},
  {"kind":"alias","raw_tag":"ambient music","canonical":"ambient","note":"Ambient"},
  {"kind":"alias","raw_tag":"ambient electronic","canonical":"ambient","note":"Ambient"},
  {"kind":"alias","raw_tag":"ambient techno","canonical":"ambient techno","note":"Ambient"},
  {"kind":"alias","raw_tag":"experimental electronic","canonical":"experimental","note":"Experimental / Noise"},
  {"kind":"alias","raw_tag":"experimental music","canonical":"experimental","note":"Experimental / Noise"},
  {"kind":"alias","raw_tag":"experiemental","canonical":"experimental","note":"Experimental / Noise"},
  {"kind":"alias","raw_tag":"noise music","canonical":"noise","note":"Experimental / Noise"},
  {"kind":"alias","raw_tag":"power electronics","canonical":"power electronics","note":"Experimental / Noise"},
  {"kind":"alias","raw_tag":"electronics","canonical":"electronica","note":"Electronica"},
  {"kind":"alias","raw_tag":"idm/electronica","canonical":"electronica","note":"Electronica"},
  {"kind":"alias","raw_tag":"intelligent dance music","canonical":"IDM","note":"IDM"},
  {"kind":"alias","raw_tag":"idm","canonical":"IDM","note":"IDM"},
  {"kind":"alias","raw_tag":"avant garde","canonical":"avant-garde","note":"Avant-garde"},
  {"kind":"alias","raw_tag":"avant-garde music","canonical":"avant-garde","note":"Avant-garde"},
  {"kind":"alias","raw_tag":"avant-pop","canonical":"avant-garde pop","note":"Avant-garde"},
  {"kind":"alias","raw_tag":"e-l-e-c-t-r-o","canonical":"electro","note":"Electro"},
  {"kind":"alias","raw_tag":"eletrohouse","canonical":"electro house","note":"Electro"},
  {"kind":"alias","raw_tag":"eletro","canonical":"electro","note":"Electro"},
  {"kind":"alias","raw_tag":"acidtechno","canonical":"acid techno","note":"Acid"},
  {"kind":"alias","raw_tag":"acid techno","canonical":"acid techno","note":"Acid"},
  {"kind":"alias","raw_tag":"acid trance","canonical":"acid trance","note":"Acid"},
  {"kind":"alias","raw_tag":"acid house","canonical":"acid house","note":"Acid"},
  {"kind":"alias","raw_tag":"juke","canonical":"footwork","note":"Footwork / Juke"},
  {"kind":"alias","raw_tag":"juke/footwork","canonical":"footwork","note":"Footwork / Juke"},
  {"kind":"alias","raw_tag":"chicago juke","canonical":"footwork","note":"Footwork / Juke"},
  {"kind":"alias","raw_tag":"club music","canonical":"club","note":"Club"},
  {"kind":"alias","raw_tag":"roots reggae","canonical":"reggae","note":"Dub"},
  {"kind":"alias","raw_tag":"dub music","canonical":"dub","note":"Dub"},
  {"kind":"alias","raw_tag":"digital dub","canonical":"dub","note":"Dub"},
  {"kind":"alias","raw_tag":"lo-fi house","canonical":"lo-fi house","note":"House variants"},
  {"kind":"alias","raw_tag":"lofi house","canonical":"lo-fi house","note":"House variants"},
  {"kind":"alias","raw_tag":"berlin school","canonical":"Berlin-school","note":"Berlin-School"},
  {"kind":"alias","raw_tag":"berlin-school","canonical":"Berlin-school","note":"Berlin-School"},
  {"kind":"alias","raw_tag":"gabba","canonical":"gabber","note":"Gabber / Hardcore"},
  {"kind":"alias","raw_tag":"hardcore techno","canonical":"hardcore","note":"Gabber / Hardcore"},
  {"kind":"alias","raw_tag":"hard techno","canonical":"hard techno","note":"Gabber / Hardcore"},
  {"kind":"alias","raw_tag":"hard trance","canonical":"hard trance","note":"Gabber / Hardcore"},
  {"kind":"alias","raw_tag":"hardstyle music","canonical":"hardstyle","note":"Gabber / Hardcore"},
  {"kind":"alias","raw_tag":"noise-jazz","canonical":"noise jazz","note":"Noise"},
  {"kind":"alias","raw_tag":"pop and chart","canonical":"pop","note":"Pop"},
  {"kind":"alias","raw_tag":"bass music","canonical":"bass","note":"Bass music"},
  {"kind":"alias","raw_tag":"uk bass","canonical":"UK bass","note":"Bass music"},
  {"kind":"alias","raw_tag":"uk drill","canonical":"UK drill","note":"Drill"},
  {"kind":"alias","raw_tag":"rnb","canonical":"R&B","note":"R&B"},
  {"kind":"alias","raw_tag":"rhythm & blues","canonical":"R&B","note":"R&B"},
  {"kind":"alias","raw_tag":"rhythm and blues","canonical":"R&B","note":"R&B"},
  {"kind":"alias","raw_tag":"contemporary r&b","canonical":"R&B","note":"R&B"},
  {"kind":"alias","raw_tag":"alternative rnb","canonical":"alternative R&B","note":"R&B"},
  {"kind":"alias","raw_tag":"afrohouse","canonical":"Afro house","note":"Afro"},
  {"kind":"alias","raw_tag":"afro tech","canonical":"afro tech","note":"Afro"},
  {"kind":"alias","raw_tag":"afrobeats","canonical":"Afrobeat","note":"Afro"},
  {"kind":"alias","raw_tag":"afro beats","canonical":"Afrobeat","note":"Afro"},
  {"kind":"alias","raw_tag":"left field electronic","canonical":"leftfield","note":"Electronic variants that map to something more specific"},
  {"kind":"alias","raw_tag":"leftfield electronic","canonical":"leftfield","note":"Electronic variants that map to something more specific"},
  {"kind":"alias","raw_tag":"left-field","canonical":"leftfield","note":"Electronic variants that map to something more specific"},
  {"kind":"alias","raw_tag":"youth crew","canonical":"hardcore punk","note":"Punk"},
  {"kind":"discard","raw_tag":"electronic","canonical":null,"note":"Platform / catalogue noise"},
  {"kind":"discard","raw_tag":"electronic music","canonical":null,"note":"Platform / catalogue noise"},
  {"kind":"discard","raw_tag":"edm","canonical":null,"note":"Platform / catalogue noise"},
  {"kind":"discard","raw_tag":"dance","canonical":null,"note":"Platform / catalogue noise"},
  {"kind":"discard","raw_tag":"dance music","canonical":null,"note":"Platform / catalogue noise"},
  {"kind":"discard","raw_tag":"music","canonical":null,"note":"Platform / catalogue noise"},
  {"kind":"discard","raw_tag":"club","canonical":null,"note":"too vague on its own — kept here; use \"club music\" → \"club\" alias above if desired"},
  {"kind":"discard","raw_tag":"rave","canonical":null,"note":"Platform / catalogue noise"},
  {"kind":"discard","raw_tag":"club music","canonical":null,"note":"comment out if you want to keep this as a genre"},
  {"kind":"discard","raw_tag":"female vocalists","canonical":null,"note":"Descriptor tags (not genres)"},
  {"kind":"discard","raw_tag":"female vocalist","canonical":null,"note":"Descriptor tags (not genres)"},
  {"kind":"discard","raw_tag":"women in music","canonical":null,"note":"Descriptor tags (not genres)"},
  {"kind":"discard","raw_tag":"women","canonical":null,"note":"Descriptor tags (not genres)"},
  {"kind":"discard","raw_tag":"lgbtq","canonical":null,"note":"Descriptor tags (not genres)"},
  {"kind":"discard","raw_tag":"queer","canonical":null,"note":"Descriptor tags (not genres)"},
  {"kind":"discard","raw_tag":"poc","canonical":null,"note":"Descriptor tags (not genres)"},
  {"kind":"discard","raw_tag":"black artists","canonical":null,"note":"Descriptor tags (not genres)"},
  {"kind":"discard","raw_tag":"seen live","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"live","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"favorites","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"favourites","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"favorite","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"favourite","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"love at first listen","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"loved","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"love","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"best","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"awesome","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"good","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"liked","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"classic","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"all","canonical":null,"note":"Last.fm listener-behaviour tags"},
  {"kind":"discard","raw_tag":"album","canonical":null,"note":"Format / release tags"},
  {"kind":"discard","raw_tag":"albums","canonical":null,"note":"Format / release tags"},
  {"kind":"discard","raw_tag":"ep","canonical":null,"note":"Format / release tags"},
  {"kind":"discard","raw_tag":"single","canonical":null,"note":"Format / release tags"},
  {"kind":"discard","raw_tag":"mix","canonical":null,"note":"Format / release tags"},
  {"kind":"discard","raw_tag":"dj mix","canonical":null,"note":"Format / release tags"},
  {"kind":"discard","raw_tag":"dj set","canonical":null,"note":"Format / release tags"},
  {"kind":"discard","raw_tag":"dj","canonical":null,"note":"Format / release tags"},
  {"kind":"discard","raw_tag":"producer","canonical":null,"note":"Format / release tags"},
  {"kind":"discard","raw_tag":"underground","canonical":null,"note":"Era / mood (too vague)"},
  {"kind":"discard","raw_tag":"alternative","canonical":null,"note":"Era / mood (too vague)"},
  {"kind":"discard","raw_tag":"alternative electronic","canonical":null,"note":"Era / mood (too vague)"},
  {"kind":"discard","raw_tag":"indie","canonical":null,"note":"Era / mood (too vague)"},
  {"kind":"discard","raw_tag":"indie electronic","canonical":null,"note":"Era / mood (too vague)"},
  {"kind":"discard","raw_tag":"indie dance","canonical":null,"note":"Era / mood (too vague)"},
  {"kind":"discard","raw_tag":"german","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"germany","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"german electronic","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"british","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"american","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"america","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"american pianist","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"uk","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"british electronic","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"us","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"usa","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"united states","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"canadian","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"french","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"france","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"italy","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"italian","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"swedish","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"korean","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"nigeria","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"albania","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"albanian","canonical":null,"note":"Nationality meta-tags"},
  {"kind":"discard","raw_tag":"spotify","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"soundcloud","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"bandcamp","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"unknown","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"???","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"various artists","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"2020s","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"male vocalist","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"male vocalists","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"actress","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"adam j owens","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"added for google code-in 2016","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"always alive recordings","canonical":null,"note":"Misc noise"},
  {"kind":"discard","raw_tag":"amelie lens","canonical":null,"note":"Misc noise"},
  {"kind":"word_fix","raw_tag":"avantgarde","canonical":"avant-garde","note":"word-boundary spelling fix, applied before alias lookup"},
]

async function main() {
  const counts = {}
  for (const r of RULES) counts[r.kind] = (counts[r.kind] ?? 0) + 1
  console.log(`seed-genre-tag-rules${DRY_RUN ? ' (DRY RUN)' : ''}`)
  console.log(`  ${RULES.length} rule(s): ` +
    Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', '))

  if (DRY_RUN) { console.log('Dry run — nothing written.'); return }

  let seeded = 0
  for (let i = 0; i < RULES.length; i += 200) {
    const batch = RULES.slice(i, i + 200)
    const { error } = await supabase
      .from('genre_tag_rules')
      .upsert(batch, { onConflict: 'kind,raw_tag', ignoreDuplicates: true })
    if (error) {
      if (error.code === '42P01') {
        console.error('\ngenre_tag_rules does not exist — run ' +
          'supabase_migration_genre_tag_rules.sql in the Supabase SQL editor first.')
        process.exit(1)
      }
      console.error(`  batch failed: ${error.message}`)
      process.exitCode = 1
    } else {
      seeded += batch.length
    }
  }

  const { count, error: countErr } = await supabase
    .from('genre_tag_rules').select('id', { count: 'exact', head: true })
  if (countErr) throw countErr
  console.log(`Upserted ${seeded} row(s); table now holds ${count} rule(s).`)
}

main().catch(err => { console.error('\nFailed:', err?.message ?? err); process.exit(1) })
