// ============================================================
// Shared SoundCloud bio-processing helpers.
//
// Used by enrich-bios.mjs (HTML-scraping pipeline) and
// sync-soundcloud.mjs (API pipeline) so the bio parsing
// logic lives in one place.
// ============================================================

// ------------------------------------------------------------
// Decode a handful of common HTML entities that can appear in
// bio text (more likely in HTML-scraped content than API
// responses, but kept here so both pipelines behave the same).
// ------------------------------------------------------------
export function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#10;|&#xA;|&#xa;/g, "\n");
}

// ------------------------------------------------------------
// SoundCloud falls back to a generic, templated description when
// an account has no custom bio set, e.g.:
//   "Listen to 3LNA | SoundCloud is an audio platform that lets
//    you listen to what you love and share the sounds you create.."
// Treat that boilerplate as "no bio".
// ------------------------------------------------------------
const GENERIC_DESCRIPTION_REGEX =
  /^Listen to .+\|\s*SoundCloud is an audio platform that lets you listen to what/i;

export function isGenericDescription(text) {
  return GENERIC_DESCRIPTION_REGEX.test(text);
}

// ------------------------------------------------------------
// gate.sc is a link-click tracker SoundCloud wraps external URLs
// in when rendering them in the browser, e.g.:
//   https://gate.sc?url=https%3A%2F%2Flinktr.ee%2Famelie.lens&token=...
// Decoding these before running extractLinktree ensures Linktree
// URLs hidden inside gate.sc redirects are still found. Rarely
// appears in API responses (it's a browser-client rendering
// behaviour) but handled defensively for consistency.
// ------------------------------------------------------------
export function decodeGateSc(text) {
  return text.replace(
    /https?:\/\/gate\.sc\?url=([^&\s"<>]+)(?:&[^\s"<>]*)*/g,
    (_, encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return _;
      }
    }
  );
}

// ------------------------------------------------------------
// Split a description into its bio text plus any booking,
// management, or contact info, so each can be stored separately
// on the artists table.
//
// Two label styles are handled:
//
//  1. Inline value:   "Booking: agent@agency.com"
//     The value (email/URL) follows the keyword on the same line.
//     Only that value is captured; the bio context continues.
//
//  2. Blank label:    "Booking:"
//     The label is alone on its line; the *next* line is the value.
//
//  3. Section header: "BOOKING REQUESTS" / "MANAGEMENT / GENERAL REQUESTS"
//     The text after the keyword has no contact info (it's a
//     descriptor like "REQUESTS" or "/ GENERAL REQUESTS"). This
//     switches the parser into "section mode": everything that
//     follows (until the next label) is collected into that section.
//
// Standalone email addresses in the bio section (no keyword prefix)
// are treated as contact info and extracted from the bio.
//
// "NEWS:" lines are skipped — any URL that followed them is extracted
// separately by extractLinktree (after gate.sc redirect decoding).
// ------------------------------------------------------------

// Anchored to the start of the line so that ordinary bio sentences
// merely *mentioning* these words aren't mistaken for a label line.
// (?!@) prevents email addresses like mgmt@agency.com, contact@…,
// booking@… from being mistaken for label lines.
const LABEL_LINE_REGEX =
  /^(?:for\s+(?:all\s+)?)?(bookings?|management|mgmt|contact)\b(?!@)\s*[:\-–—]?\s*(.*)$/i;

// A lone email address on a line (no surrounding text).
const EMAIL_ONLY_REGEX = /^[\w.+%-]+@[\w.-]+\.[a-z]{2,}$/i;

function categorizeLabel(label) {
  const lower = label.toLowerCase();
  if (lower.startsWith("booking")) return "booking";
  if (lower === "management" || lower === "mgmt") return "management";
  if (lower === "contact") return "contact";
  return null;
}

// Returns true if the text contains actual contact info (email,
// URL, or phone number), not just descriptor words like "REQUESTS".
function hasContactInfo(text) {
  return (
    /[\w.+%-]+@[\w.-]+\.[a-z]{2,}/i.test(text) || // email
    /https?:\/\//i.test(text) ||                    // URL
    /\+?\d[\d\s\-().]{6,}/i.test(text)             // phone
  );
}

export function parseDescription(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const bioLines = [];
  const info = { booking: [], management: [], contact: [] };
  // "section" tracks whether we're inside an all-caps section header
  // block (style 3 above). Starts as 'bio'; switches when we see a
  // section-header label; resets to 'bio' when we see a NEWS: line.
  let section = "bio";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip "NEWS:" marker lines — any URL that follows is handled by
    // extractLinktree (after gate.sc decoding).
    if (/^news\s*:/i.test(line)) {
      section = "bio";
      continue;
    }

    const match = line.match(LABEL_LINE_REGEX);
    const category = match && categorizeLabel(match[1]);

    if (category) {
      const inlineValue = match[2].trim();

      if (inlineValue && hasContactInfo(inlineValue)) {
        // Style 1: "Booking: agent@agency.com" — single-value capture.
        info[category].push(inlineValue);
      } else if (!inlineValue) {
        // Style 2: "Booking:" — value is on the next line.
        if (i + 1 < lines.length) {
          info[category].push(lines[++i]);
        }
      } else {
        // Style 3: section-header descriptor — switch to section mode.
        section = category;
      }
      continue;
    }

    // Non-label line.
    if (section !== "bio") {
      info[section].push(line);
    } else if (EMAIL_ONLY_REGEX.test(line)) {
      // A bare email in bio context is contact info.
      info.contact.push(line);
    } else {
      bioLines.push(line);
    }
  }

  return {
    bio: bioLines.join("\n").trim() || null,
    booking: info.booking.join("\n").trim() || null,
    management: info.management.join("\n").trim() || null,
    contact: info.contact.join("\n").trim() || null,
  };
}
