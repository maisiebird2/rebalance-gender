// ============================================================
// non-genre-hints.mjs
//
// Heuristics for flagging `genres` rows that probably are NOT
// musical genres — places ("london", "los angeles"), decades,
// listening/library metadata, artist & label names, roles, and
// junk tags. Used by genre-report.mjs to add a `suspected_non_genre`
// column for human review.
//
// HINT-ONLY by design: it flags for a person to confirm, it never
// auto-deletes. Lists were tuned against a real ~1240-row export,
// but they are still approximate. Two known-hard categories —
// arbitrary artist names and record-label names — can't be caught
// reliably by a static list; the surest signal there is
// cross-referencing the artists table (does a genre name equal an
// artist's name?), which lives in the DB, not here. What we catch
// below are the obvious/common cases.
//
// Matching rule: unless noted, sets are matched against the WHOLE
// normalised name, so nationality/city prefixes on real genres are
// safe — "turkish" flags, "turkish rock" does not; "detroit" flags,
// "detroit techno" does not.
//
// Pure data + a pure function, no side effects.
// ============================================================

function norm(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim()
}

// ── Countries, nationalities, languages ──────────────────
const COUNTRIES = new Set([
  'usa', 'us', 'uk', 'england', 'scotland', 'wales', 'ireland', 'britain',
  'great britain', 'france', 'germany', 'deutschland', 'spain', 'espana',
  'portugal', 'italy', 'italia', 'netherlands', 'the netherlands', 'holland',
  'belgium', 'flanders', 'sweden', 'norway', 'norge', 'denmark', 'finland',
  'iceland', 'poland', 'russia', 'ukraine', 'greece', 'turkey', 'austria',
  'switzerland', 'czech republic', 'czechia', 'slovakia', 'slovenia',
  'croatia', 'serbia', 'bulgaria', 'romania', 'hungary', 'albania', 'estonia',
  'latvia', 'lithuania', 'canada', 'mexico', 'guatemala', 'belize', 'ecuador',
  'brazil', 'argentina', 'chile', 'colombia', 'peru', 'venezuela', 'japan',
  'china', 'taiwan', 'korea', 'south korea', 'india', 'pakistan', 'thailand',
  'australia', 'new zealand', 'south africa', 'nigeria', 'ghana', 'gabon',
  'kenya', 'uganda', 'zimbabwe', 'egypt', 'morocco', 'tunisia', 'israel',
  'lebanon', 'iran', 'saudi arabia', 'jamaica', 'cuba', 'greenland',
  // nationalities / language adjectives
  'american', 'british', 'english', 'irish', 'scottish', 'welsh', 'french',
  'german', 'italian', 'italiana', 'spanish', 'portuguese', 'dutch',
  'belgian', 'swedish', 'norwegian', 'danish', 'finnish', 'icelandic',
  'polish', 'russian', 'ukrainian', 'greek', 'turkish', 'austrian', 'swiss',
  'czech', 'slovak', 'slovenian', 'croatian', 'serbian', 'bulgarian',
  'romanian', 'hungarian', 'magyar', 'albanian', 'latvian', 'estonian',
  'lithuanian', 'canadian', 'mexican', 'brazilian', 'brazillian', 'argentine',
  'argentinian', 'chilean', 'colombian', 'peruvian', 'venezuelan', 'japanese',
  'chinese', 'taiwanese', 'korean', 'indian', 'pakistani', 'thai',
  'australian', 'south african', 'nigerian', 'ghanaian', 'gabonese',
  'tunisian', 'iranian', 'saudi', 'saudi arabian', 'jamaican', 'latina',
  'latino', 'nacional', 'francais', 'italiana', 'magyar', 'hollands',
  'deutsch', 'belgisch', 'eigentijds', 'dansbaar',
])

// ── Continents / broad regions ───────────────────────────
const REGIONS = new Set([
  'europe', 'european', 'western european', 'asia', 'asian', 'africa',
  'african', 'america', 'americas', 'north america', 'south america',
  'latin america', 'scandinavia', 'scandinavian', 'nordic', 'balkans',
  'balkan', 'middle east', 'west coast', 'east coast', 'midwest', 'the south',
  'bay area', 'gulf coast', 'north west', 'southwest', 'sahara',
])

// ── US states ────────────────────────────────────────────
const US_STATES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york state', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington state', 'west virginia', 'wisconsin', 'wyoming',
])

// ── Cities ───────────────────────────────────────────────
const CITIES = new Set([
  'london', 'loud ldn', 'manchester', 'bristol', 'birmingham', 'leeds',
  'glasgow', 'edinburgh', 'liverpool', 'sheffield', 'brighton', 'los angeles',
  'la', 'san francisco', 'new york', 'new york city', 'nyc', 'brooklyn',
  'chicago', 'detroit', 'atlanta', 'miami', 'houston', 'dallas', 'seattle',
  'portland', 'boston', 'philadelphia', 'philly', 'washington dc', 'oakland',
  'new orleans', 'nashville', 'austin', 'las vegas', 'denver', 'memphis',
  'milwaukee', 'minneapolis', 'kansas city', 'monterrey', 'toronto',
  'montreal', 'vancouver', 'mexico city', 'sao paulo', 'rio de janeiro',
  'buenos aires', 'berlin', 'hamburg', 'cologne', 'frankfurt', 'munich',
  'mannheim', 'paris', 'marseille', 'lyon', 'madrid', 'barcelona', 'lisbon',
  'amsterdam', 'rotterdam', 'brussels', 'antwerp', 'gent', 'ghent',
  'stockholm', 'oslo', 'copenhagen', 'helsinki', 'reykjavik', 'warsaw',
  'moscow', 'kyiv', 'kiev', 'athens', 'istanbul', 'vienna', 'zurich',
  'geneva', 'prague', 'budapest', 'dublin', 'aarhus', 'arhus', 'tokyo',
  'osaka', 'seoul', 'beijing', 'shanghai', 'hong kong', 'mumbai', 'delhi',
  'bangkok', 'sydney', 'melbourne', 'auckland', 'cape town', 'johannesburg',
  'lagos', 'accra', 'nairobi', 'cairo', 'tel aviv', 'kingston', 'havana',
])

// ── Roles / people descriptors (not genres) ──────────────
const ROLES = new Set([
  'pianist', 'american pianist', 'french pianist', 'guitarist', 'drummer',
  'bassist', 'violinist', 'cellist', 'saxophonist', 'trumpeter', 'vocalist',
  'singer', 'soloist', 'mezzo-soprano', 'soprano', 'tenor', 'baritone',
  'composer', 'composers', 'songwriter', 'musician', 'music producer',
  'producer', 'performer', 'band', 'duo', 'duos', 'trio', 'quartet',
  'dj', 'djs', 'djing', 'disc jockey', 'disc jockeys', 'dj tools',
  'cover artist', 'noise artist', 'voice actor', 'german voice actor',
])

// ── Listening / library metadata & non-genre catch-alls ──
const METADATA = new Set([
  'favorites', 'favourites', 'my favorites', 'my favourites', 'favorite',
  'favourite', 'favorite bands', 'favoritos', 'favoritas', 'seen live',
  'want to see live', 'good', 'great', 'awesome', 'amazing', 'cool',
  'beautiful', 'best', 'love', 'loved', 'love at first listen', 'catchy',
  'banger', 'bangers', 'vibes', 'mood', 'chill', 'chilled', 'discover',
  'discover weekly', 'great discovery', 'passion of discovery', 'to check out',
  'need to rate', 'checked', 'home collection', 'my top', 'my top artists',
  'my top songs', 'download', 'box set', 'singles', 'oldies',
  'songs to get high to', 'creative commons', 'library music',
  'production music', 'spotify', 'soundcloud', 'bandcamp', 'youtube', 'radio',
  'playlist', 'male vocalists', 'female vocalists', 'female vocalist',
  'male vocalist', 'female vocal', 'male and female vocal',
  'under 2000 listeners', 'albums i own', 'vinyl', 'vynil', 'cassette',
  'demo', 'unsigned', 'signed', 'label', 'record label', 'live', 'remix',
  'remixes', 'cover', 'covers', 'keygen', 'rutracker', 'niconico', 'unicode',
  'the sixty one', 'creative commons', 'international', 'other', 'new',
  'names of people', 'many names', 'star', 'legend', 'friends', 'question',
  'picture', 'numbers', 'download', 'immersive', 'crossover', 'independent',
  'indies', 'popular music',
])

// ── Junk / metadata patterns (regex on the normalised name) ──
const JUNK_PATTERNS = [
  [/\badd(ed)? to lidarr\b|_add_to_lidarr|\bto lidarr\b/, 'library-tool tag'],
  [/lidarr|beets|musicbrainz batch/, 'library-tool tag'],
  [/google code[- ]?in/, 'event/junk tag'],
  [/\bbetter than\b|\bworse than\b/, 'comparison tag'],
  [/\bborn in\b/, 'biography tag'],
  [/\bupcoming album\b|\balbum \d{4}\b/, 'release-tracking tag'],
  [/\bvictim\b|death by /, 'junk tag'],
  [/\bas artist\b|series title|two or more artists|same name|\bartist series\b/, 'data-artifact tag'],
  [/\bcheck it out\b|\bto check\b|\bneed to\b/, 'listening metadata'],
  [/\b(records|recordings)$/, 'record label'],
  [/\bradio\b/, 'radio/station'],
  [/\bsong contest\b|eurovision/, 'event/contest tag'],
  [/\bfestival\b|burning man|panorama bar|berghain/, 'venue/event tag'],
  [/^[a-z0-9]$/, 'single character'],
  [/^(\w ){2,}\w$/, 'spaced-out letters'],           // "t e c h n o", "a v a l o n ..."
  [/^(?=.*[a-z])(?=.*\d)[a-z0-9]{2,5}$/, 'code/handle'], // t61, q2, 1be, tok1d — must mix letter+digit
]

// Bare 4-digit years (decades handled separately). Deliberately does
// NOT flag short numbers like 140 / 303 (dubstep/acid tempo scenes).
const YEAR_RE = /^(19|20)\d{2}$/

// Decades / eras.
const DECADE_RE = /^(19|20)?\d0s$|^(the )?(early|mid|late) ?(19|20)?\d0s$/

export function nonGenreReason(name) {
  const n = norm(name)
  if (!n) return ''
  if (DECADE_RE.test(n)) return 'decade/era'
  if (YEAR_RE.test(n)) return 'year'
  if (COUNTRIES.has(n)) return 'country/nationality'
  if (REGIONS.has(n)) return 'region/continent'
  if (US_STATES.has(n)) return 'US state'
  if (CITIES.has(n)) return 'city'
  if (ROLES.has(n)) return 'role/person'
  if (METADATA.has(n)) return 'listening metadata'
  for (const [re, reason] of JUNK_PATTERNS) if (re.test(n)) return reason
  return ''
}
