"use client";

import { useId } from "react";
import type { Platform } from "@/lib/types";
import { platformLabel } from "@/lib/platforms";
import { normalizeProfileLink } from "@/lib/profile-links";
import { OVERFLOW_PLATFORM, type LinkAssignmentKind } from "@/lib/assign-platforms";
import {
  deriveLinkEditorState,
  editLinkRow,
  markableNotFoundPlatforms,
  newLinkRow,
  type LinkEditorState,
  type LinkRow,
} from "@/lib/link-rows";

/**
 * The profile-links editor: one list of "paste a URL" rows, with the platform
 * DERIVED from each URL and shown as read-only text.
 *
 * It replaces one field per platform (ProfileLinksFieldset, which survives for
 * the admin organisation form — see documentation/PROPOSAL-platform-links-v2.md
 * open question 8). A field per platform is fine at twenty platforms and
 * unusable at a hundred, and it also forced a choice this list doesn't have to
 * make: a second link on a platform had nowhere to go, so it was discarded.
 *
 * Two things here are stated about a platform rather than typed as a URL, and
 * so sit outside the list:
 *
 *   - The homepage field. `homepage` is first-class and first-displayed, but
 *     no host lookup can ever assign it — someone's own site is, by
 *     definition, not on a recognised domain.
 *   - The "not on this platform" chips, which record that someone looked and
 *     found nothing. Edit form only.
 */
interface Props {
  platforms: Platform[];
  value: LinkEditorState;
  onChange: (next: LinkEditorState) => void;
  /** Renders the "not on this platform" control. Admin edit form only. */
  showNotFound?: boolean;
}

export default function ProfileLinksList({
  platforms,
  value,
  onChange,
  showNotFound = false,
}: Props) {
  const fieldId = useId();
  const derived = deriveLinkEditorState(value);
  const markable = showNotFound ? markableNotFoundPlatforms(value, platforms.map((p) => p.key)) : [];

  function setRows(rows: LinkRow[]) {
    onChange({ ...value, rows });
  }

  function updateRow(id: string, text: string) {
    setRows(value.rows.map((r) => (r.id === id ? editLinkRow(r, text) : r)));
  }

  function removeRow(id: string) {
    const remaining = value.rows.filter((r) => r.id !== id);
    // Never leave the list with nothing to type into.
    setRows(remaining.length ? remaining : [newLinkRow()]);
  }

  /**
   * Canonicalises on blur, never while typing — the same rule ProfileLinkField
   * followed, and for the same reason: rewriting a URL under someone mid-keystroke
   * is hostile. The platform comes from the derivation, so a row that hasn't
   * settled on one is left exactly as typed.
   */
  function normaliseRow(id: string) {
    const row = value.rows.find((r) => r.id === id);
    const assignment = derived.rows.find((r) => r.id === id);
    if (!row || !assignment?.platform) return;
    const trimmed = row.text.trim();
    if (!trimmed) return;
    const normalised = normalizeProfileLink(assignment.platform, trimmed).url;
    if (normalised !== row.text) updateRow(id, normalised);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Homepage, which detection can never assign ─────────── */}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${fieldId}-homepage`} className="text-sm font-medium">
          Homepage
        </label>
        <input
          id={`${fieldId}-homepage`}
          type="text"
          inputMode="url"
          value={value.homepage}
          onChange={(e) => onChange({ ...value, homepage: e.target.value })}
          placeholder="https://... (their own site)"
          className={inputClass}
        />
        {noteFor(derived.homepage.kind, derived.homepage.occupiedPlatform, platforms, true)}
      </div>

      {/* ── The paste list ──────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Profile links</span>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Paste a full profile URL on each line. We work out which platform it&apos;s for.
        </p>

        {derived.rows.map((row) => {
          const label =
            row.kind === "primary" && row.platform
              ? platformLabel(platforms, row.platform)
              : row.platform === OVERFLOW_PLATFORM
                ? platformLabel(platforms, OVERFLOW_PLATFORM)
                : null;

          return (
            <div key={row.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="url"
                  aria-label="Profile link"
                  value={row.text}
                  onChange={(e) => updateRow(row.id, e.target.value)}
                  onBlur={() => normaliseRow(row.id)}
                  placeholder="https://..."
                  className={`${inputClass} flex-1`}
                />
                <span
                  className="w-28 shrink-0 truncate text-sm text-gray-600 dark:text-gray-300"
                  title={label ?? undefined}
                >
                  {label ?? ""}
                </span>
                <button
                  type="button"
                  onClick={() => removeRow(row.id)}
                  aria-label="Remove this link"
                  className="shrink-0 rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                >
                  ×
                </button>
              </div>
              {noteFor(row.kind, row.occupiedPlatform, platforms, false)}
            </div>
          );
        })}

        <div>
          <button
            type="button"
            onClick={() => setRows([...value.rows, newLinkRow()])}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            + Add link
          </button>
        </div>
      </div>

      {/* ── "Looked, and they're not on it" ─────────────────────── */}
      {showNotFound && (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${fieldId}-notfound`} className="text-sm font-medium">
            Not on these platforms
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Records that someone searched and found nothing, so the artist stops appearing
            in the missing-links queue for it.
          </p>
          {value.notFound.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {value.notFound.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() =>
                      onChange({ ...value, notFound: value.notFound.filter((k) => k !== key) })
                    }
                    className="flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    {platformLabel(platforms, key)}
                    <span aria-hidden="true">×</span>
                    <span className="sr-only">Remove</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <select
            id={`${fieldId}-notfound`}
            value=""
            onChange={(e) => {
              const key = e.target.value;
              if (key) onChange({ ...value, notFound: [...value.notFound, key] });
            }}
            disabled={markable.length === 0}
            className={`${inputClass} sm:max-w-xs`}
          >
            <option value="">Add a platform…</option>
            {markable.map((key) => (
              <option key={key} value={key}>
                {platformLabel(platforms, key)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

const inputClass =
  "rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900";

/**
 * The line under a row explaining an outcome that isn't simply "this is your
 * SoundCloud link".
 *
 * Every one of these is a case where what someone typed is not what gets
 * stored, which is the one genuinely new thing about this editor: pasting an
 * obviously-SoundCloud URL and seeing "Other" reads as broken without a reason
 * beside it.
 */
function noteFor(
  kind: LinkAssignmentKind,
  occupiedPlatform: string | undefined,
  platforms: Platform[],
  isHomepage: boolean
) {
  const error = (text: string) => (
    <p className="text-xs text-red-600 dark:text-red-400">{text}</p>
  );
  const warning = (text: string) => (
    <p className="text-xs text-amber-600 dark:text-amber-400">{text}</p>
  );
  const info = (text: string) => (
    <p className="text-xs text-gray-500 dark:text-gray-400">{text}</p>
  );

  switch (kind) {
    case "refused":
      return error("We don't accept links to X/Twitter.");
    case "not-a-url":
      return error(
        isHomepage
          ? "Enter the full address, starting with https://"
          : "Enter the full profile URL, starting with https:// — a username on its own isn't enough to tell which platform it's for."
      );
    case "duplicate":
      return warning("This link is already in the list, so it won't be added twice.");
    case "overflow":
      return info(
        `You already have a ${platformLabel(platforms, occupiedPlatform ?? "")} link above, so this one is saved as ${platformLabel(platforms, OVERFLOW_PLATFORM)}.`
      );
    case "unrecognised":
      return isHomepage
        ? null
        : info(
            `We don't recognise this site, so it's saved as ${platformLabel(platforms, OVERFLOW_PLATFORM)}.`
          );
    default:
      return null;
  }
}
