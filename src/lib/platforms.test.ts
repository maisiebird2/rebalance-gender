import { describe, it, expect } from "vitest";
import { platformDisplayLabel, platformLabel } from "./platforms";
import type { Platform } from "./types";

function platform(key: string, label: string): Platform {
  return { key, label, sort_order: 0, search_url_template: null };
}

const PLATFORMS = [
  platform("soundcloud", "SoundCloud"),
  platform("resident_advisor", "Resident Advisor"),
];

describe("platformDisplayLabel", () => {
  it("shortens Resident Advisor to RA", () => {
    expect(platformDisplayLabel(platform("resident_advisor", "Resident Advisor"))).toBe("RA");
  });

  it("passes every other platform's stored label through", () => {
    expect(platformDisplayLabel(platform("soundcloud", "SoundCloud"))).toBe("SoundCloud");
  });
});

describe("platformLabel", () => {
  it("applies the display override when resolving by key", () => {
    expect(platformLabel(PLATFORMS, "resident_advisor")).toBe("RA");
    expect(platformLabel(PLATFORMS, "soundcloud")).toBe("SoundCloud");
  });

  it("falls back to the key for an unknown platform", () => {
    expect(platformLabel(PLATFORMS, "mixcloud")).toBe("mixcloud");
  });
});
