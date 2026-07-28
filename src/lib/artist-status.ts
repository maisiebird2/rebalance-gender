// Directory-status display helpers, shared by the edit form, the artist
// page's not-approved banner, and the admin-only card badge. Client-safe.

import type { ArtistStatus } from "@/lib/types";

export const STATUSES: ArtistStatus[] = [
  "approved",
  "pending",
  "rejected",
  "not_eligible",
  "search_input",
  "sc_followee",
  "duplicate",
  "obscure",
  "not_electronic",
  "label_etc",
];

// Words shown as acronyms rather than title-cased, e.g. "sc_followee" -> "SC followee".
const ACRONYM_WORDS = new Set(["sc", "mb"]);

// Display label for a status value, e.g. "not_eligible" -> "Not eligible".
export function statusLabel(status: ArtistStatus): string {
  const words = status.split("_");
  return words
    .map((w, i) => {
      if (ACRONYM_WORDS.has(w)) return w.toUpperCase();
      return i === 0 ? w[0].toUpperCase() + w.slice(1) : w;
    })
    .join(" ");
}
