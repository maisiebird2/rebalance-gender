import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { normalisedNameKey, unaccent } from "./name-key.mjs";

describe("normalisedNameKey", () => {
  it("collapses case, spaces and punctuation", () => {
    for (const name of ["Ostgut Ton", "ostgut ton", "Ostgut-Ton", "OSTGUT  TON!"]) {
      expect(normalisedNameKey(name)).toBe("ostgutton");
    }
  });

  it("strips the diacritics NFD can decompose", () => {
    expect(normalisedNameKey("Öştgut Ton")).toBe("ostgutton");
    expect(normalisedNameKey("Brutaż")).toBe("brutaz");
    expect(normalisedNameKey("Björk")).toBe("bjork");
  });

  // The regression this module exists for. Every one of these carries its
  // diacritic inside the codepoint, so NFD leaves the letter intact and the
  // [^a-z0-9] strip then deletes it outright: "ØTTA" used to normalise to
  // "tta", and the directory search went looking for every name containing
  // those three letters. Each expectation below is Postgres's own answer.
  it("folds the letters NFD cannot decompose", () => {
    expect(normalisedNameKey("ØTTA")).toBe("otta");
    expect(normalisedNameKey("MØ")).toBe("mo");
    expect(normalisedNameKey("Æther")).toBe("aether");
    expect(normalisedNameKey("Œuvre")).toBe("oeuvre");
    expect(normalisedNameKey("Straße")).toBe("strasse");
    expect(normalisedNameKey("Łódź")).toBe("lodz");
    expect(normalisedNameKey("Ðjango")).toBe("django");
    expect(normalisedNameKey("Þorir")).toBe("thorir");
    expect(normalisedNameKey("Đorđe")).toBe("dorde");
  });

  it("keeps digits", () => {
    expect(normalisedNameKey("3MOON Records")).toBe("3moonrecords");
  });

  it("is empty when there is nothing romanisable to key on", () => {
    expect(normalisedNameKey("???")).toBe("");
    expect(normalisedNameKey("")).toBe("");
    // Postgres's unaccent() is Latin-only, so these store an empty
    // name_search too — the app agreeing is the point, not a limitation
    // being papered over. Callers must treat "" as "no usable term".
    expect(normalisedNameKey("МОЛЧАТ ДОМА")).toBe("");
    expect(normalisedNameKey("電気グルーヴ")).toBe("");
  });

  it("tolerates non-strings", () => {
    expect(normalisedNameKey(null)).toBe("");
    expect(normalisedNameKey(undefined)).toBe("");
  });

  it("does not read through to Object.prototype", () => {
    // The lookup table is a Map for this reason.
    expect(normalisedNameKey("constructor")).toBe("constructor");
    expect(normalisedNameKey("__proto__")).toBe("proto");
  });
});

describe("unaccent", () => {
  it("romanises without touching case or punctuation", () => {
    expect(unaccent("café")).toBe("cafe");
    expect(unaccent("Zürich")).toBe("Zurich");
    expect(unaccent("Ostgut-Ton")).toBe("Ostgut-Ton");
  });

  it("passes through what Postgres cannot romanise", () => {
    expect(unaccent("Иван")).toBe("Иван");
  });
});

// ---------------------------------------------------------------------
// Parity with the database.
//
// The unit tests above pin the cases that broke; this one proves the whole
// function still agrees with public.normalise_name_key() character for
// character. It is the check that catches a Postgres upgrade shipping a new
// unaccent.rules, which is the one way the generated table can go stale
// without anyone touching this repo.
//
// It needs a real connection, so it is skipped unless SUPABASE_DB_URL is in
// the environment:
//
//     set -a && . ./.env.local && set +a && npm test
//
// Run it after applying supabase_migration_normalise_name_key_function.sql,
// and after re-running npm run generate-unaccent-delta.
// ---------------------------------------------------------------------
const DB_URL = process.env.SUPABASE_DB_URL;

describe.skipIf(!DB_URL)("parity with public.normalise_name_key()", () => {
  // Fail loudly rather than skip if the branch's migration hasn't been run:
  // a silently-skipped parity test is exactly how the two definitions
  // drifted apart in the first place.
  it("the migration has been applied", () => {
    const found = execFileSync(
      "psql",
      [DB_URL!, "-At", "-c", "select to_regprocedure('public.normalise_name_key(text)') is not null"],
      { encoding: "utf8" },
    ).trim();
    expect(
      found,
      "public.normalise_name_key(text) is missing — apply " +
        "migrations/supabase_migration_normalise_name_key_function.sql first",
    ).toBe("t");
  });

  /** Ask Postgres for the key of every input, in one round trip. */
  function keysFromPostgres(inputs: string[]): string[] {
    // Inputs go over as hex-encoded UTF-8 and answers come back the same
    // way, so no character in a name can break the psql text protocol.
    const values = inputs
      .map((s) => `('${Buffer.from(s, "utf8").toString("hex")}')`)
      .join(",");
    const sql = `
      select encode(convert_to(
               coalesce(public.normalise_name_key(
                 convert_from(decode(v, 'hex'), 'UTF8')), ''), 'UTF8'), 'hex')
      from (values ${values}) t(v)
    `;
    const raw = execFileSync("psql", [DB_URL!, "-At", "-c", sql], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    // Drop ONLY psql's trailing newline. A name whose key is empty comes
    // back as an empty line, so filtering empties out would silently shift
    // every later answer up by one and compare the wrong pairs.
    const lines = raw.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.map((hex) => Buffer.from(hex, "hex").toString("utf8"));
  }

  it("agrees on every character in the BMP", () => {
    // Built with generate_series rather than a VALUES list of 63k literals:
    // the SQL stays a few lines long, so a failure prints a readable diff
    // instead of half a megabyte of hex.
    const sql = `
      select i, encode(convert_to(
               coalesce(public.normalise_name_key(chr(i)), ''), 'UTF8'), 'hex')
      from generate_series(32, 55295) as i
      union all
      select i, encode(convert_to(
               coalesce(public.normalise_name_key(chr(i)), ''), 'UTF8'), 'hex')
      from generate_series(57344, 65535) as i
    `;
    const raw = execFileSync("psql", [DB_URL!, "-At", "-F", " ", "-c", sql], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });

    const disagreements: string[] = [];
    let compared = 0;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const [cp, hex] = line.split(" ");
      const expected = Buffer.from(hex ?? "", "hex").toString("utf8");
      const ours = normalisedNameKey(String.fromCodePoint(Number(cp)));
      compared++;
      if (ours !== expected) {
        const label = Number(cp).toString(16).toUpperCase().padStart(4, "0");
        disagreements.push(
          `U+${label}: postgres ${JSON.stringify(expected)} vs ours ${JSON.stringify(ours)}`,
        );
      }
    }

    expect(compared).toBe(63456);
    expect(disagreements).toEqual([]);
  }, 120_000);

  it("agrees on whole names, not just single characters", () => {
    const names = [
      "ØTTA", "MØ", "Björk", "Ostgut-Ton", "Æther", "Straße", "Łódźka",
      "Tyler, the Creator", "M.I.A.", "A.M.", "3MOON Records", "Đorđe Đorđević",
      "Sigur Rós", "Þórir", "Œuvre", "İzmir", "ǝ", "МОЛЧАТ ДОМА", "電気グルーヴ",
      "?!?", "", "  ", "Ω", "½ Speed", "ﬁnal cut", "Ǆezva",
    ];
    expect(names.map(normalisedNameKey)).toEqual(keysFromPostgres(names));
  }, 30_000);
});
