# Recommendation Engine — Improvement Plan

This plan is based on a diagnostic run of the scoring pipeline against the
current state of the database (June 2026, 1,478 approved artists).

---

## Diagnosis

The validation set is solid: 382 artists with an average of 23 resolved
Last.fm similar artists each. That's enough to produce meaningful tuning
results. The problem is the signals, not the evaluation.

| Signal | Coverage | Root cause |
|---|---|---|
| `genre_score` | 312 / 1,478 artists (21%) | Phase 7 genre harvesting hasn't run |
| `mb_tag_score` | 0 artists | `enrich-musicbrainz.mjs` hasn't run |
| `mb_collab_score` | 0 artists | `enrich-musicbrainz.mjs` hasn't run |
| `sc_direct_follow_score` | 154 / 1,353 with SC links (11%) | `build-soundcloud-follow-graph.mjs` partially run |
| `sc_co_follow_score` | same as above | same |

The tune-weights output (mb_collab = 0.50, mb_tag = 0.00, direct_follow = 0.00)
should be disregarded. When a signal column is all zeros, any weight assigned
to it produces identical rankings — the tuner was guessing for all three of
those signals.

---

## Priority 1 — Complete the SC follow graph

**Impact: high. Effort: run one script.**

1,353 artists have SoundCloud links; only 154 have follow data. The co-follow
signal depends on shared audience across the whole directory — the denser the
graph, the more useful the signal. This is the single biggest gap.

```bash
npm run build-soundcloud-follow-graph
```

This is Phase 7a in PIPELINE.md. It fetches followings for every approved
artist with a SC link and writes directed edges to `sc_follow_edges`.

---

## Priority 2 — Run MusicBrainz enrichment

**Impact: high. Effort: run one script.**

433 artists have MusicBrainz links (added by `resolve-and-load-links-lf-mb-sp.mjs`
— external platform matching, now Phase 3 in PIPELINE.md). None have been enriched yet. Running Phase 7b populates both
`mb_tags` (folksonomy tags from the MusicBrainz community, e.g. "minimal techno",
"Berlin school", "electroacoustic") and `mb_collaborations` (artist relationships
where both artists are in the database).

```bash
npm run enrich-musicbrainz
```

MB tags are a particularly valuable signal because they're more granular than the
current genre taxonomy. Two artists both tagged "ambient techno" is a stronger
signal than two artists both tagged "techno".

After this runs, also run Phase 7d to feed MB tags into the genre pipeline:

```bash
node scripts/harvest-genres-mb.mjs
```

---

## Priority 3 — Harvest genres from Last.fm and Spotify

**Impact: high for genre coverage. Effort: run three scripts.**

The current genre signal covers only 312 artists, almost entirely from the
initial CSV import. The pipeline already has scripts to harvest genres from
Last.fm and Spotify, which between them cover 489 and 597 artists respectively.
Running Phases 7e–7g will dramatically expand coverage and improve the quality
of the genre signal.

```bash
npm run harvest-genres-lastfm    # 7e — requires LASTFM_API_KEY
npm run harvest-genres-spotify   # 7f — requires SPOTIFY_CLIENT_ID/SECRET
npm run integrate-harvested-genres  # 7g — promotes to artist_genres
```

`integrate-harvested-genres.mjs` normalises tag variants (e.g. "drum and bass",
"d&b" → "drum & bass") and filters broad/useless tags (e.g. "electronic",
"seen live"). Review the `GENRE_ALIASES` and `BROAD_TAGS` constants in that
script before running — adjusting them controls what survives into `artist_genres`.

After running, verify coverage:

```sql
select count(distinct artist_id) from artist_genres
where artist_id in (select id from artists where directory_status = 'approved');
```

---

## Priority 4 — Complete the Last.fm similar artists fetch

**Impact: small (expands validation set slightly). Effort: run one script.**

489 artists have Last.fm links; 419 have been fetched. Running the script again
closes the 70-artist gap.

```bash
npm run fetch-lastfm-similar
```

After running MusicBrainz enrichment (Priority 2), also run with `--resolve-only`
to backfill `similar_artist_id` for any similar artists that can now be matched
via a newly added MBID:

```bash
npm run fetch-lastfm-similar -- --resolve-only
```

---

## After all priorities are complete

Re-run the full scoring pipeline from scratch:

```bash
python scripts/compute-scores.py --refresh   # re-fetch all signals, update cache
python scripts/tune-weights.py               # re-tune with real data
```

Then push the new scores:

```bash
# Use the weights printed by tune-weights.py:
python scripts/push-scores.py --genre=X --mb-tag=X --mb-collab=X --direct-follow=X --co-follow=X
```

Don't forget to truncate the old scores first:

```sql
truncate table artist_similarity_scores;
```

---

## What to expect

With all signals populated, a reasonable target is Precision@10 in the
10–25% range. The current 4.5% is almost entirely explained by empty signal
tables, not a fundamental problem with the approach.

If scores remain low after full enrichment, the most likely explanation is
that the MB and LFM tag vocabularies don't overlap well enough for Jaccard
to work (e.g. one artist is tagged "techno" on MB and another is tagged
"electronic" on LFM — both mean roughly the same thing but score zero
similarity). In that case, the next step would be to canonicalise the MB
tag vocabulary through `integrate-harvested-genres.mjs` and use the
`artist_genres` table for both the genre signal and the tag signal, rather
than raw `mb_tags`.

---

## Potential future signal

Once the existing signals are populated and tuned, consider adding raw
Last.fm tags as a sixth signal directly in `scoring.py`, separate from
the canonical genre pipeline. Last.fm tags are user-generated and more
granular than the normalised genre list — useful for capturing subgenre
nuance that `integrate-harvested-genres.mjs` currently filters out. This
would require a new `lastfm_tags` table (similar to `mb_tags`) populated
by a variant of `harvest-genres-lastfm.mjs` that skips the normalisation
step.
