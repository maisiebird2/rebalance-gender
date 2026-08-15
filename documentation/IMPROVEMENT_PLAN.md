# Recommendation Engine — Improvement Plan

This plan is based on a diagnostic run of the scoring pipeline against the
current state of the database (June 2026, 1,478 approved artists).

---

## Diagnosis

> **Superseded in part (2026-07-30).** The diagnosis below was written when
> a Last.fm similar-artist validation set existed (382 artists, ~23 resolved
> similar artists each) and weights could be tuned against it. That set and
> `tune-weights.py` were removed with the rest of the Last.fm data — see
> `supabase_migration_remove_lastfm_data.sql`. The Precision@K figures quoted
> here are no longer reproducible, and there is currently no way to evaluate
> weight choices. The signal-coverage priorities below still stand on their
> own merits.

The problem was the signals, not the evaluation.

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

433 artists have MusicBrainz links (added by `resolve-and-load-links-mb-sp.mjs`
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

## Priority 3 — Harvest genres from Spotify

**Impact: high for genre coverage. Effort: run two scripts.**

The current genre signal covers only 312 artists, almost entirely from the
initial CSV import. The pipeline has scripts to harvest genres from Spotify,
covering 597 artists. Running Phases 7f–7g will expand coverage and improve
the quality of the genre signal.

(Last.fm was the other harvester here, covering 489 artists. It and every
genre it contributed were removed — see
`supabase_migration_remove_lastfm_data.sql` — so genre coverage is now
*lower* than the 312 quoted above, and Spotify plus the HÖR and Bandcamp
sources are what remain to close the gap.)

```bash
npm run harvest-genres-spotify   # 7f — requires SPOTIFY_CLIENT_ID/SECRET
npm run integrate-harvested-genres  # 7g — promotes to artist_genres
```

`integrate-harvested-genres.mjs` normalises tag variants (e.g. "drum and bass",
"d&b" → "drum & bass") and filters broad/useless tags (e.g. "electronic",
"seen live"). Review the `alias` and `discard` rules in the `genre_tag_rules`
table (admin panel → /admin/settings, or SQL) before running — adjusting them
controls what survives into `artist_genres`.

After running, verify coverage:

```sql
select count(distinct artist_id) from artist_genres
where artist_id in (select id from artists where directory_status = 'approved');
```

---

## After all priorities are complete

Re-run the full scoring pipeline from scratch:

```bash
python scripts/compute-scores.py --refresh   # re-fetch all signals, update cache
```

Then push the new scores with hand-chosen weights (there is no tuning step
any more — see the Diagnosis note):

```bash
python scripts/push-scores.py --genre=X --mb-tag=X --mb-collab=X --direct-follow=X --co-follow=X
```

Don't forget to truncate the old scores first:

```sql
truncate table artist_similarity_scores;
```

---

## What to expect

With all signals populated, a reasonable target was Precision@10 in the
10–25% range, against a then-current 4.5% that was almost entirely explained
by empty signal tables rather than a fundamental problem with the approach.
These numbers are historical: measuring Precision@K needs a validation set,
and there isn't one any more.

If scores remain low after full enrichment, the most likely explanation is
that the MB and Spotify tag vocabularies don't overlap well enough for
Jaccard to work (e.g. one artist is tagged "techno" on MB and another is
tagged "electronic" on Spotify — both mean roughly the same thing but score
zero similarity). In that case, the next step would be to canonicalise the MB
tag vocabulary through `integrate-harvested-genres.mjs` and use the
`artist_genres` table for both the genre signal and the tag signal, rather
than raw `mb_tags`.

---

## Potential future signal

This section previously proposed raw Last.fm tags as a sixth signal, kept
outside the canonical genre pipeline to preserve subgenre nuance. That is
no longer on the table — Last.fm data was dropped from the directory
entirely (see `supabase_migration_remove_lastfm_data.sql`). The equivalent
idea using a source we still trust would be raw SoundCloud `tag_list`
values, which `integrate-harvested-genres.mjs` currently normalises away.
