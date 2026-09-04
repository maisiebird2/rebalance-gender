// ============================================================
// How the pipeline introduces itself to other people's servers.
//
//   BOT_UA — for fetching public pages (profile scraping, link resolving).
//   API_UA — for MusicBrainz and Discogs, whose etiquette asks for a name,
//            a URL and a contact address.
//
// Twin of src/lib/user-agent.ts — keep the two in step.
// ============================================================

import { DEFAULT_SITE_URL } from "./site-url.mjs";

export const BOT_UA = `Mozilla/5.0 (compatible; AllFrequenciesBot/1.0; +${DEFAULT_SITE_URL})`;
export const API_UA = `AllFrequencies/1.0 (+${DEFAULT_SITE_URL}; maisiemeson@gmail.com)`;
