import { describe, it, expect } from "vitest";
import { parseArtistIdInput } from "./duplicate-of";

const ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("parseArtistIdInput", () => {
  it("accepts a bare id", () => {
    expect(parseArtistIdInput(ID)).toBe(ID);
  });

  it("trims surrounding whitespace", () => {
    expect(parseArtistIdInput(`  ${ID}\n`)).toBe(ID);
  });

  it("lowercases an uppercased id", () => {
    expect(parseArtistIdInput(ID.toUpperCase())).toBe(ID);
  });

  it("extracts the id from artist-page URLs", () => {
    const urls = [
      `https://rebalancegender.com/artist/${ID}`,
      `https://rebalancegender.com/artist/${ID}/`,
      `https://rebalancegender.com/artist/${ID}/edit`,
      `https://rebalancegender.com/artist/${ID}?from=admin`,
      `http://localhost:3000/artist/${ID}/edit?from=admin`,
      `/artist/${ID}`,
    ];
    for (const url of urls) {
      expect(parseArtistIdInput(url)).toBe(ID);
    }
  });

  it("returns null when there is no id to find", () => {
    expect(parseArtistIdInput("")).toBeNull();
    expect(parseArtistIdInput("   ")).toBeNull();
    expect(parseArtistIdInput("Aphex Twin")).toBeNull();
    expect(parseArtistIdInput("https://rebalancegender.com/artist/")).toBeNull();
    // Truncated — a UUID missing its last block is not a UUID.
    expect(parseArtistIdInput("3fa85f64-5717-4562-b3fc")).toBeNull();
  });
});
