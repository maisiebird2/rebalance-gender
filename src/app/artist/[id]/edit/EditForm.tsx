"use client";

import { useRef, useState, useTransition } from "react";
import { saveArtist, deleteArtist } from "./actions";
import type { ArtistWithRelations, LinkPlatform, ArtistStatus, ArtistLabel, Platform } from "@/lib/types";
import { platformPlaceholder } from "@/lib/platforms";

interface LocationRow {
  city: string;
  country: string;
}

interface Props {
  artist: ArtistWithRelations;
  allGenres: string[];
  platforms: Platform[];
}

const STATUSES: ArtistStatus[] = [
  "approved",
  "pending",
  "rejected",
  "not_eligible",
  "search_input",
  "sc_followee",
  "duplicate",
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

export default function EditForm({ artist, allGenres, platforms }: Props) {
  const LINK_FIELDS: { platform: LinkPlatform; label: string; placeholder: string }[] =
    platforms.map((p) => ({
      platform: p.key,
      label: p.label,
      placeholder: platformPlaceholder(p.label),
    }));

  const [isPending, startTransition] = useTransition();
  const [pendingAction, setPendingAction] = useState<"save" | "approve" | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // ── Link state ────────────────────────────────────────────────
  const [linkUrls, setLinkUrls] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const { platform } of LINK_FIELDS) {
      map[platform] = artist.links?.find((l) => l.platform === platform && !l.not_found)?.url ?? "";
    }
    return map;
  });

  const [linkNotFound, setLinkNotFound] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const { platform } of LINK_FIELDS) {
      map[platform] = artist.links?.some((l) => l.platform === platform && l.not_found) ?? false;
    }
    return map;
  });

  function updateLinkUrl(platform: string, url: string) {
    setLinkUrls((prev) => ({ ...prev, [platform]: url }));
  }

  function toggleLinkNotFound(platform: string, checked: boolean) {
    setLinkNotFound((prev) => ({ ...prev, [platform]: checked }));
    if (checked) setLinkUrls((prev) => ({ ...prev, [platform]: "" }));
  }

  // ── Submit ────────────────────────────────────────────────────
  function buildFormData(forceApprove = false): FormData | null {
    const form = formRef.current;
    if (!form) return null;

    const formData = new FormData(form);
    // Overwrite hidden inputs with current React state
    const links = LINK_FIELDS
      .filter(({ platform }) => linkUrls[platform]?.trim() || linkNotFound[platform])
      .map(({ platform }) => ({
        platform,
        url: linkNotFound[platform] ? null : linkUrls[platform].trim(),
        not_found: linkNotFound[platform] ?? false,
      }));
    formData.set("links", JSON.stringify(links));
    formData.set("genres", JSON.stringify(genres.filter(Boolean)));
    formData.set("locations", JSON.stringify(locations.filter((l) => l.city || l.country)));
    formData.set("label_list", JSON.stringify(labelList.filter(Boolean)));
    if (forceApprove) {
      formData.set("directory_status", "approved");
    }
    return formData;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    const formData = buildFormData();
    if (!formData) return;

    setPendingAction("save");
    startTransition(async () => {
      const result = await saveArtist(formData);
      setPendingAction(null);
      if (result && "error" in result) {
        setServerError(result.error);
      }
    });
  }

  function handleSaveAndApprove() {
    setServerError(null);
    const formData = buildFormData(true);
    if (!formData) return;

    setPendingAction("approve");
    startTransition(async () => {
      const result = await saveArtist(formData);
      setPendingAction(null);
      if (result && "error" in result) {
        setServerError(result.error);
      }
    });
  }

  // ── Label state ───────────────────────────────────────────────
  const [labelList, setLabelList] = useState<string[]>(
    artist.label_list?.length > 0
      ? artist.label_list.map((l: ArtistLabel) => l.name)
      : [""]
  );

  function addLabel() {
    setLabelList((prev) => [...prev, ""]);
  }

  function removeLabel(i: number) {
    setLabelList((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      return next.length > 0 ? next : [""];
    });
  }

  function updateLabel(i: number, value: string) {
    setLabelList((prev) => prev.map((l, idx) => (idx === i ? value : l)));
  }

  // ── Genre state ───────────────────────────────────────────────
  const [genres, setGenres] = useState<string[]>(
    artist.genres?.map((g) => g.name).length > 0
      ? artist.genres.map((g) => g.name)
      : [""]
  );

  function addGenre() {
    setGenres((prev) => [...prev, ""]);
  }

  function removeGenre(i: number) {
    setGenres((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      return next.length > 0 ? next : [""];
    });
  }

  function updateGenre(i: number, value: string) {
    setGenres((prev) => prev.map((g, idx) => (idx === i ? value : g)));
  }

  // ── Location state ────────────────────────────────────────────
  const [locations, setLocations] = useState<LocationRow[]>(
    artist.locations?.length > 0
      ? artist.locations.map((l) => ({ city: l.city ?? "", country: l.country ?? "" }))
      : [{ city: "", country: "" }]
  );

  function addLocation() {
    setLocations((prev) => [...prev, { city: "", country: "" }]);
  }

  function removeLocation(i: number) {
    setLocations((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      return next.length > 0 ? next : [{ city: "", country: "" }];
    });
  }

  function updateLocation(i: number, field: keyof LocationRow, value: string) {
    setLocations((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, [field]: value } : l))
    );
  }

  // ── Derived initial values ────────────────────────────────────
  const bio =
    artist.enrichment?.find((e) => e.platform === "soundcloud")?.bio ?? "";

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-8 pb-20">
      <input type="hidden" name="artist_id" value={artist.id} />
      {/* hidden inputs — values are overwritten in handleSubmit */}
      <input type="hidden" name="links" value={JSON.stringify(LINK_FIELDS.filter(({ platform }) => linkUrls[platform]?.trim() || linkNotFound[platform]).map(({ platform }) => ({ platform, url: linkNotFound[platform] ? null : linkUrls[platform].trim(), not_found: linkNotFound[platform] ?? false })))} />
      <input type="hidden" name="genres" value={JSON.stringify(genres.filter(Boolean))} />
      <input type="hidden" name="locations" value={JSON.stringify(locations.filter((l) => l.city || l.country))} />
      <input type="hidden" name="label_list" value={JSON.stringify(labelList.filter(Boolean))} />

      {serverError && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {serverError}
        </div>
      )}

      {/* ── Basic info ─────────────────────────────────────────── */}
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold">Basic info</legend>

        <Field label="Name" name="name" defaultValue={artist.name} required />

        <Field
          label="Pronouns"
          name="pronouns"
          defaultValue={artist.pronoun?.value ?? ""}
          placeholder="she/her"
        />

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Labels / crews</span>
          {labelList.map((label, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={label}
                onChange={(e) => updateLabel(i, e.target.value)}
                placeholder="e.g. Ostgut Ton"
                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
              />
              {labelList.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeLabel(i)}
                  className="rounded-md px-2 py-2 text-sm text-gray-400 hover:text-red-500"
                  aria-label="Remove label"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={addLabel}
            className="self-start text-sm text-violet-600 hover:underline dark:text-violet-400"
          >
            + Add label
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium" htmlFor="directory_status">
            Status
          </label>
          <select
            id="directory_status"
            name="directory_status"
            defaultValue={artist.directory_status}
            className="w-40 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </div>
      </fieldset>

      {/* ── Location ───────────────────────────────────────────── */}
      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">Location</legend>

        {locations.map((loc, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <div className="flex flex-col gap-1">
              {i === 0 && (
                <span className="text-xs font-medium text-gray-500">City</span>
              )}
              <input
                type="text"
                value={loc.city}
                onChange={(e) => updateLocation(i, "city", e.target.value)}
                placeholder="City"
                className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
              />
            </div>
            <div className="flex flex-col gap-1">
              {i === 0 && (
                <span className="text-xs font-medium text-gray-500">Country</span>
              )}
              <input
                type="text"
                value={loc.country}
                onChange={(e) => updateLocation(i, "country", e.target.value)}
                placeholder="Country"
                className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
              />
            </div>
            {locations.length > 1 && (
              <button
                type="button"
                onClick={() => removeLocation(i)}
                className="mb-0.5 rounded-md px-2 py-2 text-sm text-gray-400 hover:text-red-500"
                aria-label="Remove location"
              >
                ✕
              </button>
            )}
          </div>
        ))}

        <button
          type="button"
          onClick={addLocation}
          className="text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          + Add location
        </button>
      </fieldset>

      {/* ── Genres ─────────────────────────────────────────────── */}
      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">Genres</legend>

        {genres.map((genre, i) => (
          <div key={i} className="flex items-center gap-2">
            <select
              value={genre}
              onChange={(e) => updateGenre(i, e.target.value)}
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            >
              <option value="">— select a genre —</option>
              {allGenres.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>

            {genres.length > 1 && (
              <button
                type="button"
                onClick={() => removeGenre(i)}
                className="rounded-md px-2 py-2 text-sm text-gray-400 hover:text-red-500"
                aria-label="Remove genre"
              >
                ✕
              </button>
            )}
          </div>
        ))}

        <button
          type="button"
          onClick={addGenre}
          className="text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          + Add genre
        </button>
      </fieldset>

      {/* ── Links ──────────────────────────────────────────────── */}
      <fieldset className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <legend className="px-1 text-sm font-medium text-gray-600 dark:text-gray-400">
          Profile links
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {LINK_FIELDS.map(({ platform, label, placeholder }) => (
            <div key={platform} className="flex flex-col gap-1">
              <label htmlFor={`link_${platform}`} className="text-sm font-medium">
                {label}
              </label>
              <input
                id={`link_${platform}`}
                type="url"
                value={linkUrls[platform] ?? ""}
                onChange={(e) => updateLinkUrl(platform, e.target.value)}
                placeholder={placeholder}
                disabled={linkNotFound[platform]}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-900"
              />
              <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={linkNotFound[platform] ?? false}
                  onChange={(e) => toggleLinkNotFound(platform, e.target.checked)}
                  className="rounded"
                />
                Not found
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      {/* ── Bio & contact ──────────────────────────────────────── */}
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold">Bio &amp; contact</legend>

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
            <button
              type="button"
              onClick={handleSaveAndApprove}
              disabled={isPending}
              className="rounded-md bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {pendingAction === "approve" ? "Approving…" : "Save and approve"}
            </button>
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

// ── Small helpers ─────────────────────────────────────────────────

function Field({
  label,
  name,
  defaultValue,
  placeholder,
  required,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </label>
      <input
        id={name}
        name={name}
        type="text"
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
      />
    </div>
  );
}

function TextArea({
  label,
  name,
  defaultValue,
  rows = 4,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  rows?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        defaultValue={defaultValue}
        rows={rows}
        className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
      />
    </div>
  );
}
