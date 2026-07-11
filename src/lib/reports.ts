// src/lib/reports.ts
//
// Registry of admin "Reports". Each entry is a one-button report that, when
// triggered, downloads a LibreOffice/OpenDocument spreadsheet (.ods) built
// server-side. The admin Reports page (src/app/admin/reports/page.tsx) renders
// one download button per entry, and each entry's `endpoint` is an
// auth-guarded API route under /api/admin/reports/ that returns the .ods.
//
// To add a new report: append an entry here and create the matching route.
// The page and its buttons pick it up automatically — no other wiring needed.

export interface ReportDefinition {
  /** Stable slug — matches the API route segment and the download filename. */
  slug: string;
  /** Short title shown on the button/card. */
  title: string;
  /** One-line description of what the report contains. */
  description: string;
  /** GET endpoint that streams the .ods download. */
  endpoint: string;
}

export const REPORTS: ReportDefinition[] = [
  {
    slug: "harvest-failures",
    title: "Harvest failures",
    description:
      "Every current harvest failure (one row per artist + service), with the artist name linked to their edit page. Columns: artist, URL, status, detail, service, occurred at.",
    endpoint: "/api/admin/reports/harvest-failures",
  },
];
