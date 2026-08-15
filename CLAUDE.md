# Project instructions

## Where things go

The repo was reorganised on 2026-08-15 to keep the root readable. Put new
files in the right place rather than at the root.

### Markdown → `documentation/`

**Every `.md` file in this repo lives in `documentation/`.** When you create
a new plan, proposal, design note, or reference doc, write it to
`documentation/<NAME>.md` — never to the repo root and never next to the
code it describes (`scripts/PIPELINE.md` and friends used to live in
`scripts/`; they were moved).

The two deliberate exceptions, both of which must stay at the root to work:

- `README.md` — GitHub renders it as the repo landing page.
- `CLAUDE.md` — this file; it is only auto-loaded from the root.

When source code refers to a doc in a comment, use the repo-relative path
(`documentation/PIPELINE.md`), not a bare filename. Links *between* docs are
plain sibling filenames (`[SCORING.md](SCORING.md)`), since they share a
directory.

### Supabase SQL → `migrations/`

All `supabase_*.sql` files live in `migrations/` — the `supabase_migration_*`
schema changes plus the `supabase_check_*` / `supabase_add_indexes` /
`supabase_delete_*` helper scripts. These are applied by hand in the Supabase
SQL editor; the directory is not managed by the Supabase CLI.

Migrations refer to each other by bare filename (they are siblings). Source
comments naming a migration also use the bare filename — the names are
unique, so a single grep finds them.

### Generated spreadsheets → outside the repo

**No `.csv` or `.ods` file belongs in this checkout.** Generated review
sheets, audit trails, ambiguity reports and failure dumps go to:

```
/Users/maisiebird/Claude/Projects/Rebalance Gender/output files
```

which is `<repo>/../output files`, the sibling of the checkout. `.gitignore`
blanket-ignores `*.csv` and `*.ods` as a backstop.

Note that the *scripts* have not been migrated yet — most still write into
the repo root or a recreated `outputs/` directory. See
[documentation/OUTPUT-FILE-LOCATION-PROPOSAL.md](documentation/OUTPUT-FILE-LOCATION-PROPOSAL.md)
for the full inventory and the proposed helper. If you touch a script that
writes a spreadsheet, moving it onto the new convention is a welcome
drive-by; if you add a *new* one, write to `output files/` from the start.

The exception is `.cache/` — `pair-scores.csv` and the backfill `.ods` are
machine-to-machine intermediates, not deliverables. They stay in `.cache/`.

## Working agreements

- Branch before editing; never commit directly to `main`.
- Use inclusive language everywhere — chat, code, comments, commit messages,
  PR text and docs.
