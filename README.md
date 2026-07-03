# Rebalance Gender

A Next.js + Supabase directory of women and gender-expansive people in
electronic music--DJs, producers, and vocalists. 

Visitors can browse and filter by genre and country;
anyone can submit a new artist, which goes into a moderation queue.

## Setup

### 1. Create the Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. Open the **SQL Editor** and run `supabase_schema_current.sql` (in the
   project root) to create all tables, enums, functions, triggers, and
   RLS policies. This file is a schema dump of the live database — the
   `supabase_migration_*.sql` files alongside it are historical
   migrations already reflected in the dump; you don't need to run them
   on a fresh setup.
3. Note on Storage: profile images are re-hosted in a public bucket
   named `artist-images`. It isn't part of the SQL schema, but no
   manual step is needed — `scripts/store-images.mjs` creates the
   bucket automatically on first run.
4. Go to **Project Settings → API**:
   - On the **Data API** sub-page, copy the **Project URL** (also shown
     as "API URL"), e.g. `https://xxxxxxxxxxxx.supabase.co`. This is
     different from the "Database URL" / Postgres connection string
     shown elsewhere in Settings → Database — you don't need that one
     for this app.
   - On the **API Keys** sub-page, create (if you don't have them yet)
     and copy the **publishable key** (`sb_publishable_...`) and a
     **secret key** (`sb_secret_...`). These replace the older `anon`
     and `service_role` keys — if your project still only shows
     "Legacy API Keys", click **Create new API keys** first.

### 2. Configure environment variables

`.env.local.example` is in this folder (`wem-directory/`), alongside
`package.json`. It's a template listing the three values the app needs but
with no actual values filled in.

1. Open a terminal in this folder (`wem-directory/`) and run:

   ```bash
   cp .env.local.example .env.local
   ```

   This creates a new file, `.env.local`, which is your personal copy —
   it's already listed in `.gitignore` so it won't be committed.

2. Open `.env.local` in a text editor. You'll see three empty variables:

   ```bash
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
   SUPABASE_SECRET_KEY=
   ```

3. Fill each one in with the matching value from step 1
   (Supabase dashboard → **Project Settings → API**):

   - `NEXT_PUBLIC_SUPABASE_URL` — the **Project URL** / **API URL**
     from the **Data API** sub-page (e.g.
     `https://xxxxxxxxxxxx.supabase.co`). Just the base URL — don't
     add `/rest/v1/` or anything else after it; the Supabase client
     library adds that itself.
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — the **publishable key**
     (`sb_publishable_...`) from the **API Keys** sub-page
   - `SUPABASE_SECRET_KEY` — a **secret key** (`sb_secret_...`) from
     the same **API Keys** sub-page

   Each line should end up looking like
   `NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co` (no quotes,
   no spaces around the `=`).

4. Save the file.

The `NEXT_PUBLIC_` prefixed values are safe to expose in the browser (RLS
restricts the publishable key to read-only access to approved artists).
The secret key is server-only and bypasses RLS entirely — never prefix
it with `NEXT_PUBLIC_` and never commit `.env.local` to a repo.

> **Note on key names:** Supabase recently renamed its API keys —
> `anon` → **publishable key**, `service_role` → **secret key**. If your
> project still only shows "Legacy API Keys" (`anon`/`service_role`),
> those still work too; just rename the env vars above to
> `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` and
> update `src/lib/supabase.ts` to match, or click **Create new API keys**
> in the dashboard to get the new-style keys instead.

### 3. Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 4. Load the data

`scripts/migrate.mjs` loads `women, femmes, enbies of electronic music -
list (genres normalized).csv`, `genres_lookup.csv`, and
`pronouns_lookup.csv` (all in the project root, one level up from this
app) into Supabase. It uses plain Node — no extra install needed.

First, do a dry run (parses everything and reports counts, but writes
nothing):

```bash
DRY_RUN=1 npm run migrate
```

If that looks right, run it for real:

```bash
npm run migrate
```

This inserts ~1,450 artists as `status: 'approved'`, plus their genres,
locations, and platform links. It refuses to run if the `artists` table
already has rows (to avoid creating duplicates) — if you need to start
over, run `truncate table artists cascade;` in the Supabase SQL editor
first.

Note: Beatport, Qobuz, and Discogs links are built from slugs/IDs in the
spreadsheet and are best-effort — some may not resolve to the exact
profile until cleaned up during the enrichment pass.

### 5. Deploy

**Deploy to Vercel**

1. Push this repo to GitHub and import it at [vercel.com/new](https://vercel.com/new).
2. Add the same three environment variables under **Settings → Environment Variables**.
3. Click **Deploy**. Vercel gives you a default `*.vercel.app` URL straight away.

**Connect your Porkbun domain**

To use your own domain instead of the default Vercel URL:

1. In Vercel, go to your project → **Settings → Domains** → **Add Domain**. Enter your domain (e.g. `rebalance-gender.com`).
2. Vercel will show the DNS records to add. Copy the values — for an apex domain (`example.com`) it's an **A record**; for a `www` subdomain it's a **CNAME record**.
3. In Porkbun, go to **Domain Management**, find your domain, and click **DNS**.
4. Add the record(s) Vercel specified:
   - **A record** (apex, e.g. `rebalance-gender.com`): Type = `A`, Host = leave blank or `@`, Answer = IP from Vercel (typically `76.76.21.21`), TTL = `600`
   - **CNAME record** (`www`): Type = `CNAME`, Host = `www`, Answer = the CNAME value Vercel gave you, TTL = `600`
5. Delete any existing A or CNAME records on those same hosts that Porkbun added by default, to avoid conflicts.
6. Back in Vercel, it will verify the records automatically — once propagated (usually a few minutes, up to 48 hours) the domain status turns green.

> **Tip:** Add both `rebalance-gender.com` and `www.rebalance-gender.com` in Vercel's Domains settings and set one to redirect to the other so both work.

## Project structure

- `src/app/page.tsx` — directory page (server component, fetches from
  Supabase, supports `?genre=`, `?country=`, `?search=` query params)
- `src/app/submit/page.tsx` — submission form page
- `src/app/api/submit/route.ts` — API route that inserts new submissions
  as `status: 'pending'` using the secret key
- `src/components/ArtistCard.tsx` — artist card (profile image, genres,
  location, links, latest track)
- `src/components/FilterBar.tsx` — genre/country/search filter controls
- `src/components/SubmissionForm.tsx` — the submission form UI
- `src/app/admin/missing-links/` — admin tool for finding and filling
  artists' missing platform links (inline suggestions, manual paste,
  search links; see "Missing-links admin page" in CONTEXT.md)
- `src/lib/supabase.ts` — Supabase client helpers (public + admin)
- `src/lib/queries.ts` — data-fetching functions for the directory
- `src/lib/types.ts` — TypeScript types mirroring the database schema

## Notes

- Images are loaded via `next/image` with SoundCloud's CDN domains
  allow-listed in `next.config.ts`. Add other domains there as more
  enrichment sources are added.
- The directory page revalidates hourly (`export const revalidate = 3600`
  in `page.tsx`) since enriched data is cached in the database rather than
  fetched live.
# rebalance-gender
