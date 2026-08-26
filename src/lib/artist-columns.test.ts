import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PUBLIC_ARTIST_COLUMNS } from "./artist-columns.mjs";

// The static half of scripts/check-artists-column-grants.mjs.
//
// That script proves the grants are right by probing the live database, which
// means it only runs when someone remembers to run it and the database is
// reachable. This checks the same invariant against the migration that
// defines the grants — no network, so it runs on every `npm test`.
//
// It catches the failure that actually costs something: adding a column to
// PUBLIC_ARTIST_COLUMNS (and so to ARTIST_SELECT) without granting it. The
// site would then 42501 for every anonymous visitor while working perfectly
// for an admin, whose service-role client bypasses column grants entirely.
const MIGRATION = path.join(
  __dirname,
  "../../migrations/supabase_migration_artists_private_columns.sql",
);

/** The column names inside the migration's `GRANT SELECT (...)` clause. */
function grantedColumns(): string[] {
  // `--` comment lines go first: the migration's header explains the pattern
  // with a worked example that itself contains "GRANT SELECT (new_column)",
  // and matching that instead of the real statement yields a short, wrong
  // list that makes the subset assertions pass vacuously.
  const sql = readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const clause = /GRANT SELECT\s*\(([^)]*)\)\s*ON TABLE/i.exec(sql)?.[1];
  if (!clause) throw new Error(`No GRANT SELECT (...) ON TABLE in ${MIGRATION}`);
  return [...clause.matchAll(/"(\w+)"/g)].map((m) => m[1]);
}

/** The private columns the migration's header lists as deliberately ungranted. */
const PRIVATE_COLUMNS = [
  "notes",
  "submitted_by_email",
  "submitted_at",
  "reviewed_at",
  "gender_mb",
];

describe("PUBLIC_ARTIST_COLUMNS", () => {
  it("is a subset of the columns the migration grants", () => {
    const granted = new Set(grantedColumns());
    const ungranted = PUBLIC_ARTIST_COLUMNS.filter((c) => !granted.has(c));
    expect(ungranted).toEqual([]);
  });

  it("does not leak a private column into the public read shape", () => {
    const leaked = PUBLIC_ARTIST_COLUMNS.filter((c) =>
      PRIVATE_COLUMNS.includes(c),
    );
    expect(leaked).toEqual([]);
  });

  it("has no duplicates", () => {
    expect(PUBLIC_ARTIST_COLUMNS).toHaveLength(
      new Set(PUBLIC_ARTIST_COLUMNS).size,
    );
  });

  it("finds a real grant list to check against", () => {
    // Guards the parse itself: if the migration is reformatted and the regex
    // matches nothing useful, every assertion above passes vacuously. This
    // caught the first version of grantedColumns(), which matched the worked
    // example in the header comment instead of the statement.
    //
    // name_search is the tell — it is granted but is not in
    // PUBLIC_ARTIST_COLUMNS, so finding it proves we parsed the real GRANT
    // rather than echoing the list we are checking.
    const granted = grantedColumns();
    expect(granted).toContain("name_search");
    expect(granted).toContain("profile_image_url");
  });
});
