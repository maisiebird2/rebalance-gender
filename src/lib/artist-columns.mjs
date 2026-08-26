// The artist columns the public site is allowed to read — one definition.
//
// anon and authenticated hold COLUMN-LEVEL SELECT grants on artists (see
// supabase_migration_artists_private_columns.sql), not table-level ones, so
// PostgREST rejects `select=*` for those roles and every select has to name
// its columns. This array is that list. It must stay a subset of the GRANT in
// that migration; the private columns (notes, submitted_by_email,
// submitted_at, reviewed_at, gender_mb) are readable only through the
// service-role client, which uses its own select strings — ARTIST_ADMIN_SELECT
// on the edit page.
//
// It lives in its own leaf module, with no imports, for two reasons:
//
//   1. src/lib/queries.ts builds ARTIST_SELECT from it, and
//      scripts/check-artists-column-grants.mjs probes the live database with
//      it. Those are the two places that must agree — the checker exists to
//      prove the site's select still matches the database's grants, so a
//      second hand-maintained copy of the list defeats the check. It had
//      already gone stale once: the checker kept probing for `labels` after
//      supabase_migration_drop_artists_labels.sql removed the column, and
//      reported a dropped column as a broken grant.
//   2. queries.ts pulls in next/cache and the Supabase clients, so a plain
//      `node` script cannot import it. Keeping the list dependency-free is
//      what lets the checker share it rather than copy it.
//
// A column added here without a matching GRANT now fails in one obvious
// place: src/lib/artist-columns.test.ts checks this array against the
// migration's grant list without needing a database.
//
// name_search is deliberately absent. It is granted — the directory search
// filters on it, and a role needs SELECT on a column to use it in a WHERE
// clause — but nothing selects it, so it is not part of the public read
// shape. The checker probes it separately.
export const PUBLIC_ARTIST_COLUMNS = [
  "id",
  "name",
  "pronoun_id",
  "directory_status",
  "duplicate_of",
  "profile_image_url",
  "profile_image_source",
  "profile_image_fetched_at",
  "booking_info",
  "management_info",
  "contact_info",
  "deleted",
  "created_at",
  "updated_at",
];
