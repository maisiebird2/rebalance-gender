// Single source of truth for the Discover input's example names. Used by
// both the header dropdown (DiscoverMenu) and the /discover page; one is
// picked at random on each page load. Edit this list to change the
// suggestions — this is the only place to update them.
export const SAMPLE_ARTISTS = [
  "Peggy Gou",
  "David Guetta",
  "Martin Garrix",
  "Alok",
  "Armin Van Buuren",
  "Timmy Trumpet",
  "FISHER",
  "Skrillex",
  "Afrojack",
  "Anyma",
  "Vintage Culture",
  "Don Diablo",
  "Steve Aoki",
  "Tiësto",
  "Indira Paganotto",
  "Amelie Lens",
  "Lilly Palmer",
  "Nora En Pure",
  "Deborah De Luca",
  "Chris Lake",
  "Zeds Dead",
  "Boys Noize",
  "Subtronics",
  "Crankdat",
  "Knock2",
  "Kaytranada",
  "A. G. Cook",
  "Brutalismus 3000",
  "DJ Anderson do Paraíso",
  "REZZ",
  "Ninajirachi",
  "Alison Wonderland",
  "Charlotte de Witte",
  "Fred again...",
  "Sara Landry",
  "Miss Monique",
  "Honey Dijon",
];

/** A random name from SAMPLE_ARTISTS. */
export function randomSampleArtist(): string {
  return SAMPLE_ARTISTS[Math.floor(Math.random() * SAMPLE_ARTISTS.length)];
}
