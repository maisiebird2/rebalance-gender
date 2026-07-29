// ============================================================
// genre-vocab.mjs
//
// The genre normalisation vocabulary, loaded from the
// genre_tag_rules table (see supabase_migration_genre_tag_rules.sql).
// This replaces the GENRE_ALIASES / BROAD_TAGS / WORD_FIXES
// constants that used to be hard-coded in
// integrate-harvested-genres.mjs — edit rules in /admin/settings
// (or SQL), not in code.
//
// Rule kinds:
//   'alias'    — raw_tag → canonical display name ('dnb' → 'drum & bass')
//   'discard'  — raw_tag is too vague / not a genre; harvested rows
//                matching it are skipped (canonical is NULL)
//   'word_fix' — word-boundary substitution applied BEFORE alias
//                lookup ('avantgarde' → 'avant-garde'), so compound
//                forms like 'avantgarde rock' are fixed too
//
// loadGenreVocab(supabase) fetches every rule and returns a vocab
// object whose normaliseTag() behaves exactly like the old
// hard-coded function: word fixes first, then spaced-letter
// collapse, then discard check (exact, then accent/hyphen-
// normalised), then alias lookup (exact, then normalised), else
// store the accent-stripped lowercase tag as-is.
//
// It THROWS if the table is missing, unreadable, or empty: running
// the pipeline with no vocabulary would silently re-create every
// duplicate genre the rules exist to prevent, so failing hard is
// the safe behaviour. Seed with scripts/seed-genre-tag-rules.mjs.
// ============================================================

// Strip Unicode combining characters (accents, diacritics).
// "alté" → "alte", "Ü" → "U", etc.
export function removeAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// Produce a normalised key for deduplication comparison:
// strip accents, replace hyphens with spaces, lowercase, trim.
// Used for rule lookup and genre cache keys — NOT for the stored
// canonical name, which preserves intentional hyphens
// (e.g. "2-step garage", "nu-breaks").
export function normalizeForLookup(str) {
  return removeAccents(str).replace(/-/g, ' ').toLowerCase().trim()
}

// Collapse "stylised" spelled-out genre names where every character
// is separated by spaces or hyphens — e.g. "t e c h n o" → "techno",
// "e-l-e-c-t-r-o" → "electro". Only fires when the name is 3+ tokens
// that are ALL single characters, so real multi-word genres
// ("drum & bass", "2-step garage", "nu-breaks", "a cappella") are
// never touched. The collapsed form then flows through the normal
// alias/discard lookup, so it dedupes against the real genre.
export function collapseSpacedLetters(str) {
  const tokens = str.trim().split(/[\s-]+/).filter(Boolean)
  if (tokens.length >= 3 && tokens.every((t) => t.length === 1)) {
    return tokens.join('')
  }
  return str
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const PAGE_SIZE = 1000

// Load every rule from genre_tag_rules and build the vocab object.
// `supabase` must be a client using the service key (the table has
// RLS on with no anon policy).
export async function loadGenreVocab(supabase) {
  const rules = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('genre_tag_rules')
      .select('kind, raw_tag, canonical')
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      throw new Error(
        `Could not load genre_tag_rules (${error.message}). ` +
        'Run supabase_migration_genre_tag_rules.sql in the Supabase SQL editor, ' +
        'then seed with: node scripts/seed-genre-tag-rules.mjs'
      )
    }
    rules.push(...data)
    if (data.length < PAGE_SIZE) break
  }

  if (rules.length === 0) {
    throw new Error(
      'genre_tag_rules is empty — refusing to run with no vocabulary ' +
      '(every alias/discard rule would be ignored and duplicate genres ' +
      'would be created). Seed with: node scripts/seed-genre-tag-rules.mjs'
    )
  }

  const aliases  = new Map()   // raw_tag (lowercase) → canonical
  const discard  = new Set()   // raw_tag (lowercase)
  const wordFixes = []         // [regex, replacement]
  for (const r of rules) {
    if (r.kind === 'alias') aliases.set(r.raw_tag, r.canonical)
    else if (r.kind === 'discard') discard.add(r.raw_tag)
    else if (r.kind === 'word_fix') {
      // The stored word is matched literally on word boundaries —
      // never compiled as a raw pattern, so a bad row can't break us.
      wordFixes.push([new RegExp(`\\b${escapeRegex(r.raw_tag)}\\b`, 'g'), r.canonical])
    }
  }

  // Pre-computed accent/hyphen-normalised lookups.
  const aliasesNorm = new Map([...aliases].map(([k, v]) => [normalizeForLookup(k), v]))
  const discardNorm = new Set([...discard].map(normalizeForLookup))

  // Normalise a raw tag to its canonical form.
  // Returns { canonical: string|null, skip: boolean }.
  function normaliseTag(rawTag) {
    let lower = rawTag.toLowerCase().trim()

    for (const [pattern, replacement] of wordFixes) {
      lower = lower.replace(pattern, replacement)
    }

    lower = collapseSpacedLetters(lower)

    const norm = normalizeForLookup(lower)

    // Discard check first (exact, then normalised) — discard beats
    // alias when a tag has both kinds of rule (e.g. "club music").
    if (discard.has(lower) || discardNorm.has(norm)) {
      return { canonical: null, skip: true }
    }

    if (aliases.has(lower))     return { canonical: aliases.get(lower),     skip: false }
    if (aliasesNorm.has(norm))  return { canonical: aliasesNorm.get(norm),  skip: false }

    // Unknown tag — strip accents and store lowercase.
    // Special-cased acronyms/capitalisations all come from alias rules above.
    return { canonical: removeAccents(lower), skip: false }
  }

  return {
    normaliseTag,
    counts: {
      alias: aliases.size,
      discard: discard.size,
      word_fix: wordFixes.length,
      total: rules.length,
    },
  }
}
