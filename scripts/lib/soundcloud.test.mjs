import { describe, it, expect } from "vitest";
import {
  isSoundCloudUrl,
  upgradeAvatarUrl,
  normalizeScUrl,
  cleanScUrl,
  createSoundcloudClient,
} from "./soundcloud.mjs";

describe("isSoundCloudUrl", () => {
  it("accepts soundcloud.com and its subdomains", () => {
    expect(isSoundCloudUrl("https://soundcloud.com/artist")).toBe(true);
    expect(isSoundCloudUrl("https://on.soundcloud.com/abc")).toBe(true);
    expect(isSoundCloudUrl("http://www.soundcloud.com/x")).toBe(true);
  });

  it("rejects other hosts and unparseable input", () => {
    expect(isSoundCloudUrl("https://open.spotify.com/artist/1")).toBe(false);
    expect(isSoundCloudUrl("https://notsoundcloud.com/x")).toBe(false);
    expect(isSoundCloudUrl("not a url")).toBe(false);
    expect(isSoundCloudUrl("")).toBe(false);
  });
});

describe("upgradeAvatarUrl", () => {
  it("rewrites the -large variant to -t500x500", () => {
    expect(upgradeAvatarUrl("https://i1.sndcdn.com/avatars-abc-large.jpg")).toBe(
      "https://i1.sndcdn.com/avatars-abc-t500x500.jpg"
    );
    expect(upgradeAvatarUrl("https://i1.sndcdn.com/avatars-abc-large")).toBe(
      "https://i1.sndcdn.com/avatars-abc-t500x500"
    );
  });

  it("returns null for missing values", () => {
    expect(upgradeAvatarUrl(null)).toBeNull();
    expect(upgradeAvatarUrl("")).toBeNull();
    expect(upgradeAvatarUrl(undefined)).toBeNull();
  });
});

describe("normalizeScUrl", () => {
  it("lowercases and strips query/hash/trailing slash for dedupe keys", () => {
    expect(normalizeScUrl("https://SoundCloud.com/Foo/?utm=1#h")).toBe(
      "https://soundcloud.com/foo"
    );
    expect(normalizeScUrl("https://soundcloud.com/bar")).toBe("https://soundcloud.com/bar");
  });
});

describe("cleanScUrl", () => {
  it("strips tracking params but preserves case", () => {
    expect(cleanScUrl("https://soundcloud.com/Damacha?utm_medium=api&x=1")).toBe(
      "https://soundcloud.com/Damacha"
    );
  });

  it("returns the input unchanged when unparseable", () => {
    expect(cleanScUrl("not a url")).toBe("not a url");
  });
});

describe("createSoundcloudClient", () => {
  it("exposes the expected client surface without touching the network", () => {
    const client = createSoundcloudClient({ debug: false });
    expect(typeof client.getAccessToken).toBe("function");
    expect(typeof client.soundcloudGet).toBe("function");
    expect(typeof client.resolveUser).toBe("function");
    expect(typeof client.getFollowings).toBe("function");
  });
});
