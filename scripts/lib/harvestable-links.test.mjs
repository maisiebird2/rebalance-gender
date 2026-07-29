import { describe, it, expect } from "vitest";
import { onlyHarvestableLinks } from "./harvestable-links.mjs";

// A minimal chainable stand-in for a postgrest query builder that just
// records the filter calls made on it.
function recordingQuery() {
  const calls = [];
  const query = {
    calls,
    not: (...args) => {
      calls.push(["not", ...args]);
      return query;
    },
    eq: (...args) => {
      calls.push(["eq", ...args]);
      return query;
    },
  };
  return query;
}

describe("onlyHarvestableLinks", () => {
  it("excludes url-less rows and human-adjudicated not_found rows", () => {
    const query = recordingQuery();
    const result = onlyHarvestableLinks(query);
    expect(result).toBe(query); // chainable — callers keep building on it
    expect(query.calls).toEqual([
      ["not", "url", "is", null],
      ["eq", "not_found", false],
    ]);
  });
});
