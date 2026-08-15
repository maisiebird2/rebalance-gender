# Rebalance Gender

A Next.js + Supabase directory of women and gender-expansive people in
electronic music--DJs, producers, and vocalists. 

Visitors can browse and filter by genre and country;
anyone can submit a new artist, which goes into a moderation queue.

## Layout

| Directory | Contents |
|---|---|
| `src/` | the Next.js application |
| `scripts/` | the harvesting / enrichment / reporting pipeline |
| `documentation/` | all project documentation — see [documentation/README.md](documentation/README.md) |
| `migrations/` | Supabase SQL, applied by hand in the SQL editor |
| `public/` | static assets |

Start with [documentation/CONTEXT.md](documentation/CONTEXT.md) for the
project overview, or [documentation/PIPELINE.md](documentation/PIPELINE.md)
for the ordered data pipeline.

Generated spreadsheets (`.csv` / `.ods`) are **not** kept in this repo — they
are written to the `output files/` folder beside the checkout. See
[documentation/OUTPUT-FILE-LOCATION.md](documentation/OUTPUT-FILE-LOCATION.md).
