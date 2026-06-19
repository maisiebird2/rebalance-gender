"use client";

import { useRef, useState, useTransition } from "react";
import { PLATFORM_LABELS } from "@/lib/platforms";
import { saveArtist, deleteArtist } from "./actions";
import type { ArtistWithRelations, LinkPlatform, ArtistStatus, ArtistLabel } from "@/lib/types";

interface LinkRow {
  platform: LinkPlatform;
  url: string;
}

interface LocationRow {
  city: string;
  country: string;
}

interface Props {
  artist: ArtistWithRelations;
  allGenres: string[];
}

const PLATFORMS = Object.keys(PLATFORM_LABELS) as LinkPlatform[];
const STATUSES: ArtistStatus[] = ["approved", "pending", "rejected"];

export default function EditForm({ artist, allGenres }: Props) {
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // ── Link state ────────────────────────────────────────────────
  const [links, setLinks] = useState<LinkRow[]>(
    artist.links?.map((l) => ({
      platform: l.platform,
      url: l.url,
    })) ?? []
  );

  function addLink() {
    setLinks((prev) => [...prev, { platform: "other", handle: "", url: "" }]);
  }

  function removeLink(i: number) {
    setLinks((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateLink(i: number, field: keyof LinkRow, value: string) {
    setLinks((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, [field]: value } : l))
    );
  }

  // ── Submit ────────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);

    const form = formRef.current;
    if (!form) return;

    const formData = new FormData(form);
    // Overwrite hidden inputs with current React state
    formData.set("links", JSON.stringify(links));
    formData.set("genres", JSON.stringify(genres.filter(Boolean)));
    formData.set("locations", JSON.stringify(locations.filter((l) => l.city || l.country)));
    formData.set("label_list", JSON.stringify(labelList.filter(Boolean)));

    startTransition(async () => {
      const result = await saveArtist(formData);
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
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-8">
      <input type="hidden" name="artist_id" value={artist.id} />
      {/* hidden inputs — values are overwritten in handleSubmit */}
      <input type="hidden" name="links" value={JSON.stringify(links)} />
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
          <label className="text-sm font-medium" htmlFor="status">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={artist.status}
            className="w-40 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
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
      <fieldset className="space-y-4">
        <legend className="text-base font-semibold">Profile links</legend>

        {links.map((link, i) => (
          <div
            key={i}
            className="grid grid-cols-[130px_1fr_auto] items-end gap-2"
          >
            <div className="flex flex-col gap-1">
              {i === 0 && (
                <span className="text-xs font-medium text-gray-500">
                  Platform
                </span>
              )}
              <select
                value={link.platform}
                onChange={(e) =>
                  updateLink(i, "platform", e.target.value as LinkPlatform)
                }
                className="rounded-md border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                {PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              {i === 0 && (
                <span className="text-xs font-medium text-gray-500">URL</span>
              )}
              <input
                type="url"
                value={link.url}
                onChange={(e) => updateLink(i, "url", e.target.value)}
                placeholder="https://…"
                className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
              />
            </div>

            <button
              type="button"
              onClick={() => removeLink(i)}
              className="mb-0.5 rounded-md px-2 py-2 text-sm text-gray-400 hover:text-red-500"
              aria-label="Remove link"
            >
              ✕
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={addLink}
          className="text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          + Add link
        </button>
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

      {/* ── Actions ────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={isPending}
            className="rounded-md bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Save changes"}
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
