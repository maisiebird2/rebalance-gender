"use client";

import { useState, FormEvent } from "react";
import type { LinkPlatform } from "@/lib/types";

interface LocationRow {
  city: string;
  country: string;
}

interface Props {
  allGenres: string[];
}

const LINK_FIELDS: { platform: LinkPlatform; label: string; placeholder: string }[] = [
  { platform: "soundcloud", label: "SoundCloud", placeholder: "https://soundcloud.com/..." },
  { platform: "instagram", label: "Instagram", placeholder: "https://instagram.com/..." },
  { platform: "resident_advisor", label: "Resident Advisor", placeholder: "https://ra.co/dj/..." },
  { platform: "bandcamp", label: "Bandcamp", placeholder: "https://...bandcamp.com" },
  { platform: "beatport", label: "Beatport", placeholder: "https://beatport.com/artist/..." },
  { platform: "qobuz", label: "Qobuz", placeholder: "https://qobuz.com/..." },
  { platform: "discogs", label: "Discogs", placeholder: "https://discogs.com/artist/..." },
  { platform: "linktree", label: "Linktree", placeholder: "https://linktr.ee/..." },
  { platform: "apple_music", label: "Apple Music", placeholder: "https://music.apple.com/..." },
  { platform: "spotify", label: "Spotify", placeholder: "https://open.spotify.com/artist/..." },
  { platform: "musicbrainz", label: "MusicBrainz", placeholder: "https://musicbrainz.org/artist/..." },
  { platform: "lastfm", label: "Last.fm", placeholder: "https://last.fm/music/..." },
  { platform: "homepage", label: "Homepage", placeholder: "https://..." },
  { platform: "other", label: "Other link", placeholder: "https://..." },
];

type Status = "idle" | "submitting" | "success" | "error";

export default function SubmissionForm({ allGenres }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [genres, setGenres] = useState<string[]>([""]);
  const [locations, setLocations] = useState<LocationRow[]>([{ city: "", country: "" }]);
  const [labelList, setLabelList] = useState<string[]>([""]);

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

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    const form = e.currentTarget;
    const data = new FormData(form);

    const links: Partial<Record<LinkPlatform, string>> = {};
    for (const { platform } of LINK_FIELDS) {
      const value = data.get(`link_${platform}`);
      if (typeof value === "string" && value.trim()) {
        links[platform] = value.trim();
      }
    }

    const payload = {
      name: data.get("name"),
      pronouns: data.get("pronouns"),
      genres: genres.filter(Boolean),
      locations: locations.filter((l) => l.city || l.country),
      labels: labelList.filter(Boolean),
      submittedByEmail: data.get("submittedByEmail"),
      links,
    };

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Something went wrong");
      }

      setStatus("success");
      form.reset();
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  if (status === "success") {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-4 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
        Thanks! Your submission has been received and will appear once it's
        reviewed.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 pb-20">
      <Field label="Name *" name="name" required />
      <Field label="Pronouns" name="pronouns" placeholder="e.g. she/her" />

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Genres</span>
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
          className="self-start text-sm text-violet-600 hover:underline dark:text-violet-400"
        >
          + Add genre
        </button>
      </div>

      <fieldset className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <legend className="px-1 text-sm font-medium text-gray-600 dark:text-gray-400">
          Location
        </legend>
        <div className="flex flex-col gap-3">
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
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
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
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
                />
              </div>
              {locations.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeLocation(i)}
                  className="rounded-md px-2 py-2 text-sm text-gray-400 hover:text-red-500"
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
            className="self-start text-sm text-violet-600 hover:underline dark:text-violet-400"
          >
            + Add location
          </button>
        </div>
      </fieldset>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Labels / crews</span>
        {labelList.map((label, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="text"
              value={label}
              onChange={(e) => updateLabel(i, e.target.value)}
              placeholder="e.g. Ostgut Ton"
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
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

      <fieldset className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <legend className="px-1 text-sm font-medium text-gray-600 dark:text-gray-400">
          Profile links
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {LINK_FIELDS.map(({ platform, label, placeholder }) => (
            <Field
              key={platform}
              label={label}
              name={`link_${platform}`}
              placeholder={placeholder}
            />
          ))}
        </div>
      </fieldset>

      <Field
        label="Your email (optional, in case we have questions)"
        name="submittedByEmail"
        type="email"
      />

      {status === "error" && (
        <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
      )}

      {/* ── Floating action bar ────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <button
            type="submit"
            disabled={status === "submitting"}
            className="rounded-md bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {status === "submitting" ? "Submitting…" : "Submit"}
          </button>
          <a
            href="/"
            className="rounded-md px-5 py-2 text-sm font-medium text-gray-600 hover:underline dark:text-gray-300"
          >
            Cancel
          </a>
        </div>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  placeholder,
  required,
  type = "text",
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
      />
    </div>
  );
}
