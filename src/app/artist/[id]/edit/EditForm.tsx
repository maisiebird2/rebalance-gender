"use client";

import { useRef, useState, useTransition } from "react";
import { saveArtist, deleteArtist, checkDuplicateTarget } from "./actions";
import type { ArtistWithRelations, LinkPlatform, ArtistStatus, ArtistAlias, ArtistLabel, Platform } from "@/lib/types";
import TextList from "@/components/form/TextList";
import GenreList from "@/components/form/GenreList";
import LocationList, { type LocationRow } from "@/components/form/LocationList";
import ProfileLinksFieldset from "@/components/form/ProfileLinksFieldset";
import Field from "@/components/form/Field";
import TextArea from "@/components/form/TextArea";
import { mergeGenreOptions } from "@/lib/genre-options";

interface Props {
  artist: ArtistWithRelations;
  genreOptions: string[];
  platforms: Platform[];
  /** Name of the already-stored duplicate_of target, resolved by the page. */
  duplicateOfName: string | null;
}

const STATUSES: ArtistStatus[] = [
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
function statusLabel(status: ArtistStatus): string {
  const words = status.split("_");
  return words
    .map((w, i) => {
      if (ACRONYM_WORDS.has(w)) return w.toUpperCase();
      return i === 0 ? w[0].toUpperCase() + w.slice(1) : w;
    })
    .join(" ");
}

// Result of checking the "Duplicate of" entry against the database.
type DupCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; id: string; name: string }
  | { state: "error"; message: string };

export default function EditForm({ artist, genreOptions, platforms, duplicateOfName }: Props) {
  const [isPending, startTransition] = useTransition();
  const [pendingAction, setPendingAction] = useState<"save" | "approve" | "not_eligible" | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmNotEligible, setConfirmNotEligible] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // ── Field state ───────────────────────────────────────────────
  const [aliasNames, setAliasNames] = useState<string[]>(
    artist.aliases?.length > 0 ? artist.aliases.map((a: ArtistAlias) => a.name) : [""]
  );
  const [labelList, setLabelList] = useState<string[]>(
    artist.label_list?.length > 0 ? artist.label_list.map((l: ArtistLabel) => l.name) : [""]
  );
  const [genres, setGenres] = useState<string[]>(
    artist.genres?.map((g) => g.name).length > 0 ? artist.genres.map((g) => g.name) : [""]
  );
  const [locations, setLocations] = useState<LocationRow[]>(
    artist.locations?.length > 0
      ? artist.locations.map((l) => ({ city: l.city ?? "", country: l.country ?? "" }))
      : [{ city: "", country: "" }]
  );

  // ── Duplicate-of state ────────────────────────────────────────
  // The status drives whether the "Duplicate of" field is shown at all, so it
  // has to be controlled rather than left to the DOM's defaultValue.
  const [status, setStatus] = useState<ArtistStatus>(artist.directory_status);
  const [duplicateOf, setDuplicateOf] = useState(artist.duplicate_of ?? "");
  const [dupCheck, setDupCheck] = useState<DupCheck>(
    artist.duplicate_of && duplicateOfName
      ? { state: "ok", id: artist.duplicate_of, name: duplicateOfName }
      : { state: "idle" }
  );

  async function checkDuplicateOf() {
    const raw = duplicateOf.trim();
    if (!raw) {
      setDupCheck({ state: "idle" });
      return;
    }
    setDupCheck({ state: "checking" });
    const result = await checkDuplicateTarget(raw, artist.id);
    if (result.ok) {
      // Collapse a pasted URL down to the bare ID that gets stored.
      setDuplicateOf(result.id);
      setDupCheck({ state: "ok", id: result.id, name: result.name });
    } else {
      setDupCheck({ state: "error", message: result.error });
    }
  }

  // ── Link state ────────────────────────────────────────────────
  const [linkUrls, setLinkUrls] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const p of platforms) {
      map[p.key] = artist.links?.find((l) => l.platform === p.key && !l.not_found)?.url ?? "";
    }
    return map;
  });

  const [linkNotFound, setLinkNotFound] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const p of platforms) {
      map[p.key] = artist.links?.some((l) => l.platform === p.key && l.not_found) ?? false;
    }
    return map;
  });

  function updateLinkUrl(platform: LinkPlatform, url: string) {
    setLinkUrls((prev) => ({ ...prev, [platform]: url }));
  }

  function toggleLinkNotFound(platform: LinkPlatform, checked: boolean) {
    setLinkNotFound((prev) => ({ ...prev, [platform]: checked }));
    if (checked) setLinkUrls((prev) => ({ ...prev, [platform]: "" }));
  }

  // ── Submit ────────────────────────────────────────────────────
  function serializedLinks() {
    return platforms
      .filter((p) => linkUrls[p.key]?.trim() || linkNotFound[p.key])
      .map((p) => ({
        platform: p.key,
        url: linkNotFound[p.key] ? null : linkUrls[p.key].trim(),
        not_found: linkNotFound[p.key] ?? false,
      }));
  }

  function buildFormData(forceApprove = false, forceNotEligible = false): FormData | null {
    const form = formRef.current;
    if (!form) return null;

    const formData = new FormData(form);
    // Overwrite hidden inputs with current React state
    formData.set("links", JSON.stringify(serializedLinks()));
    formData.set("genres", JSON.stringify(genres.filter(Boolean)));
    formData.set("locations", JSON.stringify(locations.filter((l) => l.city || l.country)));
    formData.set("label_list", JSON.stringify(labelList.filter(Boolean)));
    formData.set("aliases", JSON.stringify(aliasNames.filter(Boolean)));
    // Always sent, even when the field is hidden: saveArtist ignores it for
    // any status other than 'duplicate' and clears the stored value.
    formData.set("duplicate_of", duplicateOf.trim());
    if (forceApprove) {
      formData.set("directory_status", "approved");
    } else if (forceNotEligible) {
      formData.set("directory_status", "not_eligible");
    }
    return formData;
  }

  function runSave(
    formData: FormData | null,
    action: "save" | "approve" | "not_eligible"
  ) {
    if (!formData) return;
    setServerError(null);
    setPendingAction(action);
    startTransition(async () => {
      const result = await saveArtist(formData);
      setPendingAction(null);
      if (result && "error" in result) {
        setServerError(result.error);
      }
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    runSave(buildFormData(), "save");
  }

  function handleSaveAndApprove() {
    runSave(buildFormData(true), "approve");
  }

  function handleSaveAndMarkNotEligible() {
    runSave(buildFormData(false, true), "not_eligible");
  }

  // ── Derived initial values ────────────────────────────────────
  const bio =
    artist.enrichment?.find((e) => e.platform === "soundcloud")?.bio ?? "";

  const mergedGenreOptions = mergeGenreOptions(genreOptions, artist);

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-8 pb-20">
      <input type="hidden" name="artist_id" value={artist.id} />
      {/* hidden inputs — values are overwritten from React state in buildFormData */}
      <input type="hidden" name="links" value={JSON.stringify(serializedLinks())} />
      <input type="hidden" name="genres" value={JSON.stringify(genres.filter(Boolean))} />
      <input type="hidden" name="locations" value={JSON.stringify(locations.filter((l) => l.city || l.country))} />
      <input type="hidden" name="label_list" value={JSON.stringify(labelList.filter(Boolean))} />
      <input type="hidden" name="aliases" value={JSON.stringify(aliasNames.filter(Boolean))} />

      {serverError && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {serverError}
        </div>
      )}

      {/* ── Basic info ─────────────────────────────────────────── */}
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold">Basic info</legend>

        <Field label="Name" name="name" defaultValue={artist.name} required />

        <TextList label="Aliases" itemNoun="alias" values={aliasNames} onChange={setAliasNames}
          placeholder="e.g. DJ Name, Former name" />

        <Field
          label="Pronouns"
          name="pronouns"
          defaultValue={artist.pronoun?.value ?? ""}
          placeholder="she/her"
        />

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium" htmlFor="directory_status">
            Status
          </label>
          <select
            id="directory_status"
            name="directory_status"
            value={status}
            onChange={(e) => setStatus(e.target.value as ArtistStatus)}
            className="w-40 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </div>

        {status === "duplicate" && (
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="duplicate_of">
              Duplicate of
            </label>
            <input
              id="duplicate_of"
              type="text"
              value={duplicateOf}
              onChange={(e) => {
                setDuplicateOf(e.target.value);
                // Drop any previous result so a stale ✓ can't sit under
                // text that has since been edited.
                setDupCheck({ state: "idle" });
              }}
              onBlur={checkDuplicateOf}
              placeholder="Artist ID, or paste the artist's page URL"
              className="rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
            />
            {dupCheck.state === "ok" ? (
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                ✓ Duplicate of{" "}
                <a
                  href={`/artist/${dupCheck.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline"
                >
                  {dupCheck.name}
                </a>
              </p>
            ) : dupCheck.state === "error" ? (
              <p className="text-xs text-red-600 dark:text-red-400">
                {dupCheck.message}
              </p>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {dupCheck.state === "checking"
                  ? "Checking…"
                  : "The entry this artist duplicates. Optional — leave blank if it isn't known yet."}
              </p>
            )}
          </div>
        )}
      </fieldset>

      {/* ── Location ───────────────────────────────────────────── */}
      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">Location</legend>
        <LocationList values={locations} onChange={setLocations} />
      </fieldset>

      {/* ── Genres ─────────────────────────────────────────────── */}
      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">Genres</legend>
        <GenreList values={genres} onChange={setGenres} options={mergedGenreOptions} />
      </fieldset>

      {/* ── Labels / crews ─────────────────────────────────────── */}
      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">Labels / crews</legend>
        <TextList itemNoun="label" values={labelList} onChange={setLabelList}
          placeholder="e.g. Ostgut Ton" />
      </fieldset>

      {/* ── Links ──────────────────────────────────────────────── */}
      <fieldset className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <legend className="px-1 text-sm font-medium text-gray-600 dark:text-gray-400">
          Profile links
        </legend>
        <ProfileLinksFieldset
          platforms={platforms}
          values={linkUrls}
          onChange={updateLinkUrl}
          notFound={linkNotFound}
          onNotFoundChange={toggleLinkNotFound}
        />
      </fieldset>

      {/* ── Bio & contact ──────────────────────────────────────── */}
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold">Bio &amp; contact</legend>

        <TextArea
          label="Internal notes (admin only — never shown publicly)"
          name="notes"
          defaultValue={artist.notes ?? ""}
          rows={3}
        />

        <TextArea
          label="Bio (SoundCloud)"
          name="bio"
          defaultValue={bio}
          rows={5}
        />

        <TextArea
          label="Booking info"
          name="booking_info"
          defaultValue={artist.booking_info ?? ""}
          rows={3}
        />

        <TextArea
          label="Management info"
          name="management_info"
          defaultValue={artist.management_info ?? ""}
          rows={3}
        />

        <TextArea
          label="Contact info"
          name="contact_info"
          defaultValue={artist.contact_info ?? ""}
          rows={3}
        />
      </fieldset>

      {/* ── Floating action bar ────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={isPending}
              className="rounded-md bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
            >
              {pendingAction === "save" ? "Saving…" : "Save changes"}
            </button>
            {artist.directory_status !== "approved" && (
              <button
                type="button"
                onClick={handleSaveAndApprove}
                disabled={isPending}
                className="rounded-md bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {pendingAction === "approve" ? "Approving…" : "Save and approve"}
              </button>
            )}
            {artist.directory_status !== "not_eligible" &&
              (!confirmNotEligible ? (
                <button
                  type="button"
                  onClick={() => setConfirmNotEligible(true)}
                  disabled={isPending}
                  className="rounded-md border border-amber-300 px-5 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-60 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950"
                >
                  Not eligible
                </button>
              ) : (
                <div className="flex items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 dark:border-amber-800 dark:bg-amber-950">
                  <span className="text-sm text-amber-700 dark:text-amber-400">
                    Mark as not eligible?
                  </span>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={handleSaveAndMarkNotEligible}
                    className="rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60"
                  >
                    {pendingAction === "not_eligible" ? "Saving…" : "Yes, mark not eligible"}
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => setConfirmNotEligible(false)}
                    className="rounded-md px-3 py-1 text-sm font-medium text-amber-700 hover:underline dark:text-amber-400"
                  >
                    No, cancel
                  </button>
                </div>
              ))}
            <a
              href={`/artist/${artist.id}`}
              className="rounded-md px-5 py-2 text-sm font-medium text-gray-600 hover:underline dark:text-gray-300"
            >
              Cancel
            </a>
          </div>

          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-md px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
            >
              Delete artist
            </button>
          ) : (
            <div className="flex items-center gap-3 rounded-md border border-red-300 bg-red-50 px-4 py-2 dark:border-red-800 dark:bg-red-950">
              <span className="text-sm text-red-700 dark:text-red-300">
                Delete {artist.name}?
              </span>
              <button
                type="button"
                disabled={isDeleting}
                onClick={async () => {
                  setIsDeleting(true);
                  await deleteArtist(artist.id);
                }}
                className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
              >
                {isDeleting ? "Deleting…" : "Yes, delete"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-md px-3 py-1 text-sm font-medium text-red-700 hover:underline dark:text-red-300"
              >
                No, cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </form>
  );
}
