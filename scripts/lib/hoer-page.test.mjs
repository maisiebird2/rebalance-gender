import { describe, it, expect } from "vitest";
import { parseArtistPage, largestImageUrl } from "./hoer-page.mjs";

describe("largestImageUrl", () => {
  it("strips a -WxH derivative suffix", () => {
    expect(largestImageUrl("https://hoer.live/wp/Name-1024x1024.jpeg")).toBe(
      "https://hoer.live/wp/Name.jpeg"
    );
  });
  it("leaves -scaled and un-suffixed originals intact", () => {
    expect(largestImageUrl("https://hoer.live/wp/Name-scaled.jpg")).toBe(
      "https://hoer.live/wp/Name-scaled.jpg"
    );
    expect(largestImageUrl("https://hoer.live/wp/Name.jpg")).toBe("https://hoer.live/wp/Name.jpg");
  });
});

describe("parseArtistPage", () => {
  it("pulls stage name, wp user id, portrait (original), and location", () => {
    const html = `
      <body class="archive author author-233733 foo">
        <h1 class="artist__title">GMOZ</h1>
        <div class="artist__image" style="background-image: url('https://hoer.live/wp/GMOZ-1024x1024.jpeg')"></div>
        <span class="artist__location">Berlin</span>
      </body>`;
    const r = parseArtistPage(html);
    expect(r.stageName).toBe("GMOZ");
    expect(r.wpUserId).toBe("233733");
    expect(r.imageUrl).toBe("https://hoer.live/wp/GMOZ.jpeg");
    expect(r.location).toBe("Berlin");
  });

  it("reads the portrait with class/style in the reverse order", () => {
    const html = `<div style="background-image: url(https://hoer.live/wp/x.jpg)" class="artist__image"></div>`;
    expect(parseArtistPage(html).imageUrl).toBe("https://hoer.live/wp/x.jpg");
  });

  it("keeps only real socials, skipping the empty JS-template block", () => {
    const html = `
      <div class="artist__socials">
        <a href=""></a><a href=""></a>
      </div>
      <div class="artist__socials">
        <a href="https://soundcloud.com/gmoz">sc</a>
        <a href="https://instagram.com/gmoz">ig</a>
        <a href="https://soundcloud.com/gmoz">dupe</a>
      </div>`;
    expect(parseArtistPage(html).socials).toEqual([
      "https://soundcloud.com/gmoz",
      "https://instagram.com/gmoz",
    ]);
  });

  it("returns nulls / empty for a bare page with none of the fields", () => {
    const r = parseArtistPage("<body class=\"archive\"><main></main></body>");
    expect(r).toEqual({
      stageName: null,
      wpUserId: null,
      imageUrl: null,
      socials: [],
      location: null,
    });
  });

  it("does not mistake author-<slug> for the numeric user id", () => {
    const html = `<body class="author-2hot2play"><h1 class="artist__title">2HOT2PLAY</h1></body>`;
    expect(parseArtistPage(html).wpUserId).toBeNull();
  });
});
