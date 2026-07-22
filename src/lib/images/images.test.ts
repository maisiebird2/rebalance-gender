import { describe, it, expect } from "vitest";
import {
  IMAGE_FAILURE_STATUS,
  imageFailureService,
  isDefinitiveImageFailure,
  isTransientImageFailure,
  platformFromImageFailureService,
} from "./failures";
import { describePlaceholderImageUrl, isPlaceholderImageUrl } from "./placeholders";

const LASTFM_PLACEHOLDER =
  "https://lastfm.freetls.fastly.net/i/u/ar0/2a96cbd8b46e442fc41c2b86b821562f.jpg";
const SC_DEFAULT_AVATAR = "https://i1.sndcdn.com/images/default_avatar_500x500.png";

describe("image failure vocabulary", () => {
  it("builds and parses the service key", () => {
    expect(imageFailureService("spotify")).toBe("image:spotify");
    expect(platformFromImageFailureService("image:spotify")).toBe("spotify");
  });

  it("does not claim service keys belonging to other concerns", () => {
    // store-images owns re-hosting failures under its own prefix; reading
    // one as an acquisition failure would corrupt the skip decision.
    expect(platformFromImageFailureService("image-store:spotify")).toBeNull();
    expect(platformFromImageFailureService("soundcloud-sync")).toBeNull();
  });

  it("classifies every status as exactly one of definitive or transient", () => {
    // An unclassified status would be silently ignored by the gate, so
    // this guards against adding one without deciding what it means.
    for (const status of Object.values(IMAGE_FAILURE_STATUS)) {
      const definitive = isDefinitiveImageFailure(status);
      const transient = isTransientImageFailure(status);
      expect(definitive || transient, `${status} is unclassified`).toBe(true);
      expect(definitive && transient, `${status} is both`).toBe(false);
    }
  });

  it("treats a known answer as definitive and an unknown one as transient", () => {
    expect(isDefinitiveImageFailure(IMAGE_FAILURE_STATUS.NO_IMAGE)).toBe(true);
    expect(isDefinitiveImageFailure(IMAGE_FAILURE_STATUS.PLACEHOLDER)).toBe(true);
    expect(isTransientImageFailure(IMAGE_FAILURE_STATUS.FETCH_FAILED)).toBe(true);
    expect(isTransientImageFailure(IMAGE_FAILURE_STATUS.WRITE_FAILED)).toBe(true);
  });

  it("does not classify an unknown status either way", () => {
    expect(isDefinitiveImageFailure("no_og_image")).toBe(false);
    expect(isTransientImageFailure("no_og_image")).toBe(false);
  });
});

describe("placeholder registry", () => {
  it("matches every size variant of the Last.fm default avatar", () => {
    expect(isPlaceholderImageUrl(LASTFM_PLACEHOLDER)).toBe(true);
    expect(
      isPlaceholderImageUrl(
        "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png"
      )
    ).toBe(true);
  });

  it("matches the SoundCloud default grey avatar", () => {
    expect(isPlaceholderImageUrl(SC_DEFAULT_AVATAR)).toBe(true);
    expect(isPlaceholderImageUrl("https://i1.sndcdn.com/avatars-abc-t500x500.jpg")).toBe(false);
  });

  it("scopes a pattern to its platform when one is given", () => {
    expect(isPlaceholderImageUrl(SC_DEFAULT_AVATAR, "soundcloud")).toBe(true);
    expect(isPlaceholderImageUrl(SC_DEFAULT_AVATAR, "spotify")).toBe(false);
  });

  it("names the placeholder it matched", () => {
    expect(describePlaceholderImageUrl(LASTFM_PLACEHOLDER)).toBe("Last.fm default star avatar");
    expect(describePlaceholderImageUrl(SC_DEFAULT_AVATAR)).toBe("SoundCloud default grey avatar");
    expect(describePlaceholderImageUrl("https://cdn.example/real.jpg")).toBeNull();
  });

  it("handles missing and non-string values", () => {
    expect(isPlaceholderImageUrl(null)).toBe(false);
    expect(isPlaceholderImageUrl(undefined)).toBe(false);
    expect(isPlaceholderImageUrl("")).toBe(false);
  });
});
