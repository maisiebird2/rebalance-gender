import { describe, it, expect } from "vitest";
import { matchMultiArtist, bioText } from "./lastfm-multi-artist.mjs";

// Every string below is a real excerpt from a Last.fm bio in our own data,
// harvested via api_response_cache (namespace 'lastfm_info'). Keeping them
// verbatim means the fixtures can't drift from the phrasings we actually hit.

describe("matchMultiArtist — disambiguation pages (must match)", () => {
  const MULTI = {
    // "more than one" family
    Cashu: "There is more than one artist / band by the name of Cashu:",
    "33": "There is more than one artist with this name:",
    "222": "There is more than one artist named 222.",
    Angie: "There is more than one artists sharing this name:",
    Al: "There is more than one artist with the name AL.",
    Aluna: "There is more than one artist associated with the name Aluna:",
    // "several" family
    Blanka: "There are several artists called Blanka:",
    "1111": "There are several artists under the alias 1111.",
    Aero: "There are several artists with this name.",
    Aimée: "There are several artists with the moniker Aimée",
    Bella: 'There are several artists going by the name "Bella".',
    Gia: "There are several artists named Gia, including GIA from Norway",
    Svarog: "There are several bands/artists releasing music under the name Svarog.",
    // "multiple" family
    A2: "There are multiple artists with the name A2.",
    Abaddon: "There are multiple artists named Abaddon:",
    Adonis: "There are multiple artists with the same name:",
    Aya: "There are multiple artists that have recorded under the name Aya.",
    Debit: "There are multiple artists that go by the name Debit.",
    Blossom: "There are multiple artists using the name Blossom:",
    Dillon: "There are multiple artists that perform under the name Dillon",
    // explicit counts, incl. digits and shouty caps
    "Adam J": "There are two artists under this name. 1 ) A DJ (more info needed)",
    "5x": "There are at least two artists called 5x: 1) A electronic music producer",
    Abra: "There are at least two known artists with this name:",
    Aga: "There are at least 2 artists with this name:",
    Akane: "There are at least 3 artists sharing this name.",
    Aisha: "There are four known artists with this name:",
    Bex: "There are FOUR artists with the same name.",
    Dev: "There are at least four artists with this name:",
    "Lip Service": "There are at least five different artists called Lip Service",
    Shima: 'There are at least two artists who record under the name "Shima".',
    // digits, large counts, and other nouns ("bands", "acts", "artists/bands")
    "747": "There is 3 bands named 747 1) 747 is a hardcore punk band from Szczecin, Poland",
    Abyss: "There are at least 21 bands by this name. 1) Abyss was a hardcore band from Germany",
    Acyl: "There are two acts under name Acyl: 1- ACYL is an experimental ethnic Metal band from France.",
    Ada: "There are at least 3 artists/bands with the name Ada. 1. Ada (Real Name: Michaela Dippel)",
    Adriana: "There are 5 artists named Adriana: 1. Adriana (also know as Adriana Arydes)",
    Clemency: "There are 2 bands by the name Clemency: 1. An indie rock/pop and alternative band",
    FM: "There are at least 6 known projects going by the name FM: 1) FM - Canadian progressive rock band.",
    Ciel: "There are at least four artists / acts called Ciel or CIEL. 1. CIEL is a post-punk",
    "Frankie Teardrop": "There are at least 2 bands with the name Frankie Teardrop: An Experimental Noise Rock 3-piece",
    // "various" as the quantifier
    "Boo (opener)": "There are various artists, called 'Boo' or BOO! : An Alt Rock band from South Africa",
    // hedged verbs
    Ams: "There appear to be two artists called AMS - how can we disambiguate?",
    "Cherry Lee": "there seems at least two artists with the same name",
    // "<Name> is the name of …"
    Weaver: "Weaver is the name of more than one artist: 1) a japanese piano rock band",
    Aida: "Aida is the name of several artists: 1. A young Finnish poprock band",
    // "another artist by the name of" (same Boo bio, later paragraph)
    "Boo (mid-bio)": "There is also another artist by the name of BOO from Tokyo, Japan.",
    // typos that really appear on Last.fm
    Acolytes: "There is one than one artist with this name: 1) Acolytes is Denesh Shan",
    "4D": "The are multiple artists that have recorded as 4D. 1. 4D is hip-hop group",
  };

  for (const [name, text] of Object.entries(MULTI)) {
    it(`flags ${name}`, () => {
      expect(matchMultiArtist(text)).not.toBeNull();
    });
  }
});

describe("matchMultiArtist — legitimate single-artist bios (must NOT match)", () => {
  // These are the near-misses that a naive "same name" / "other artists"
  // matcher would wrongly prune. All are real bios of one artist.
  const SINGLE = {
    "Andrea Parker":
      "Andrea Parker (not to be confused with the actress of the same name) is a female British techno disc jockey and producer.",
    Bec: "This Australian talent, not to be confused with recording artist Beck, got very annoyed with her boss Sandy",
    "A$AP Rocky":
      "he has contributed to production or songwriting for other artists under the pseudonym Lord Flacko.",
    "ADULT.":
      "They have also remixed other artists, most notably Felix da Housecat, Fischerspooner and Bis.",
    "Adana Twins":
      "nights inspired Take It Easy to launch a label of the same name with Doctor Dru and Davidé",
    "Brooke Candy":
      'released her debut major label single, "Opulence", with an accompanying EP of the same name on May 6, 2014.',
    "Bored Lord":
      "tracks on her personal Bandcamp as well as contributing remixes for other artists and labels.",
    "S.P.Y":
      "on which he releases mainly his music and sometimes the music of other artists.",
    Kaboom:
      "In 2009, we released a first album with the same name. Band Members: Wences de la Rosa: Drums.",
    "Akira Complex":
      "They had collaborated with a number of other artists as well, including Hommarju, Camellia, lapix",
    // Ordinary bio prose using the same quantifiers ("several", "various",
    // "multiple") with a non-artist noun — the reason the noun list stays tight.
    Flaminia:
      "She continued studying classical piano and composition, winning several competitions.",
    "DØMINA":
      "infusing sonic elements from various genres to craft an innovative and captivating experience",
    "Kelly Moran":
      "As a pianist, Kelly has given multiple recitals of contemporary piano repertoire",
    "DEBBY FRIDAY":
      "She has been featured in several publications, including: Thump, Loud & Quiet, Bandcamp",
    "Pale Blue Dot":
      "three somewhat-like-minded musicians/friends from Oakland, who met playing shows in various bands together",
  };

  for (const [name, text] of Object.entries(SINGLE)) {
    it(`leaves ${name} alone`, () => {
      expect(matchMultiArtist(text)).toBeNull();
    });
  }

  it("returns null for an empty bio", () => {
    expect(matchMultiArtist("")).toBeNull();
  });
});

describe("bioText", () => {
  it("searches both content and summary", () => {
    expect(bioText({ artist: { bio: { content: "C", summary: "S" } } })).toContain("C");
    expect(bioText({ artist: { bio: { content: "C", summary: "S" } } })).toContain("S");
  });

  it("tolerates missing bio / artist / payload without throwing", () => {
    expect(bioText({ artist: { bio: {} } }).trim()).toBe("");
    expect(bioText({ artist: {} }).trim()).toBe("");
    expect(bioText({}).trim()).toBe("");
    expect(bioText(null).trim()).toBe("");
  });

  it("finds a notice that appears only in the summary", () => {
    const payload = { artist: { bio: { summary: "There are several artists called X" } } };
    expect(matchMultiArtist(bioText(payload))).not.toBeNull();
  });
});
