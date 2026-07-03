"use client";

import { useState, useRef, FormEvent } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import type { LinkPlatform, Platform, ArtistWithRelations } from "@/lib/types";
import { platformPlaceholder } from "@/lib/platforms";
import ProfileLinkField from "./ProfileLinkField";

interface LocationRow {
  city: string;
  country: string;
}

interface Props {
  artist: ArtistWithRelations;
  allGenres: string[];
  platforms: Platform[];
}

type Status = "idle" | "submitting" | "success" | "needsVerification" | "error";

export default function RevisionForm({ artist, allGenres, platforms }: Props) {
  const LINK_FIELDS = platforms.map((p) => ({
    platform: p.key as LinkPlatform,
    label: p.label,
    placeholder: platformPlaceholder(p.label),
  }));

  // Pre-populate with existing artist data
  const [genres, setGenres] = useState<string[]>(
    artist.genres?.map((g) => g.name) ?? [""]
  );
  const [locations, setLocations] = useState<LocationRow[]>(
    artist.locations?.length
      ? artist.locations.map((l) => ({ city: l.city ?? "", country: l.country ?? "" }))
      : [{ city: "", country: "" }]
  );
  const [labelList, setLabelList] = useState<string[]>(
    artist.label_list?.length ? artist.label_list.map((l) => l.name) : [""]
  );

  // Build initial link map from existing artist links
  const initialLinks: Partial<Record<string, string>> = {};
  for (const link of artist.links ?? []) {
    if (link.url && !link.not_found) {
      initialLinks[link.platform] = link.original_url ?? link.url ?? "";
    }
  }

  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function addLabel() { setLabelList((prev) => [...prev, ""]); }
  function removeLabel(i: number) {
    setLabelList((prev) => { const n = prev.filter((_, idx) => idx !== i); return n.length ? n : [""]; });
  }
  function updateLabel(i: number, value: string) {
    setLabelList((prev) => prev.map((l, idx) => (idx === i ? value : l)));
  }

  function addLocation() { setLocations((prev) => [...prev, { city: "", country: "" }]); }
  function removeLocation(i: number) {
    setLocations((prev) => { const n = prev.filter((_, idx) => idx !== i); return n.length ? n : [{ city: "", country: "" }]; });
  }
  function updateLocation(i: number, field: keyof LocationRow, value: string) {
    setLocations((prev) => prev.map((l, idx) => (idx === i ? { ...l, [field]: value } : l)));
  }

  function addGenre() { setGenres((prev) => [...prev, ""]); }
  function removeGenre(i: number) {
    setGenres((prev) => { const n = prev.filter((_, idx) => idx !== i); return n.length ? n : [""]; });
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

    const revisionData = {
      name: (data.get("name") as string | null)?.trim() || undefined,
      pronouns: (data.get("pronouns") as string | null)?.trim() || undefined,
      genres: genres.filter(Boolean).length ? genres.filter(Boolean) : undefined,
      locations: locations.filter((l) => l.city || l.country).length
        ? locations.filter((l) => l.city || l.country)
        : undefined,
      labels: labelList.filter(Boolean).length ? labelList.filter(Boolean) : undefined,
      links: Object.keys(links).length ? links : undefined,
    };

    const payload = {
      artistId: artist.id,
      submitterEmail: data.get("submitterEmail"),
      submitterNotes: data.get("submitterNotes"),
      revisionData,
      turnstileToken,
      honeypot: data.get("_hp"),
    };

    try {
      const res = await fetch("/api/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(body.error || "Something went wrong");
      }

      if (body.requiresVerification) {
        setStatus("needsVerification");
      } else {
        setStatus("success");
      }
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  if (status === "needsVerification") {
    return (
      <div className="rounded-md border border-blue-200 bg-blue-50 p-4 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
        <p className="font-medium">Check your email</p>
        <p className="mt-1 text-sm">
          We&apos;ve sent you a confirmation link. Click it to send your suggested
          revision to our review queue. The link expires in 48 hours.
        </p>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-4 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
        Thanks! Your suggested revision has been received and will be reviewed shortly.
      </div>
    );
  }

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-4 pb-20">

      {/* ── Honeypot ─────────────────────────────────────────────── */}
      <div style={{ position: "absolute", opacity: 0, height: 0, overflow: "hidden", pointerEvents: "none" }} aria-hidden="true">
        <label htmlFor="_hp">Website</label>
        <input id="_hp" name="_hp" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        All fields are pre-filled with the current data. Update anything that&apos;s wrong or out of date.
      </p>

      <Field label="Name *" name="name" required defaultValue={artist.name} />
      <Field label="Pronouns" name="pronouns" placeholder="e.g. she/her"
        defaultValue={artist.pronoun?.value ?? ""} />

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Genres</span>
        {genres.map((genre, i) => (
          <div key={i} className="flex items-center gap-2">
            <select value={genre} onChange={(e) => updateGenre(i, e.target.value)}
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900">
              <option value="">— select a genre —</option>
              {allGenres.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            {genres.length > 1 && (
              <button type="button" onClick={() => removeGenre(i)}
                className="rounded-md px-2 py-2 text-sm text-gray-400 hover:text-red-500" aria-label="Remove genre">✕</button>
            )}
          </div>
        ))}
        <button type="button" onClick={addGenre}
          className="self-start text-sm text-violet-600 hover:underline dark:text-violet-400">
          + Add genre
        </button>
      </div>

      <fieldset className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <legend className="px-1 text-sm font-medium text-gray-600 dark:text-gray-400">Location</legend>
        <div className="flex flex-col gap-3">
          {locations.map((loc, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <div className="flex flex-col gap-1">
                {i === 0 && <span className="text-xs font-medium text-gray-500">City</span>}
                <input type="text" value={loc.city} onChange={(e) => updateLocation(i, "city", e.target.value)}
                  placeholder="City" className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900" />
              </div>
              <div className="flex flex-col gap-1">
                {i === 0 && <span className="text-xs font-medium text-gray-500">Country</span>}
                <input type="text" value={loc.country} onChange={(e) => updateLocation(i, "country", e.target.value)}
                  placeholder="Country" className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900" />
              </div>
              {locations.length > 1 && (
                <button type="button" onClick={() => removeLocation(i)}
                  className="rounded-md px-2 py-2 text-sm text-gray-400 hover:text-red-500" aria-label="Remove location">✕</button>
              )}
            </div>
          ))}
          <button type="button" onClick={addLocation}
            className="self-start text-sm text-violet-600 hover:underline dark:text-violet-400">
            + Add location
          </button>
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Labels / crews</span>
        {labelList.map((label, i) => (
          <div key={i} className="flex items-center gap-2">
            <input type="text" value={label} onChange={(e) => updateLabel(i, e.target.value)}
              placeholder="e.g. Ostgut Ton"
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900" />
            {labelList.length > 1 && (
              <button type="button" onClick={() => removeLabel(i)}
                className="rounded-md px-2 py-2 text-sm text-gray-400 hover:text-red-500" aria-label="Remove label">✕</button>
            )}
          </div>
        ))}
        <button type="button" onClick={addLabel}
          className="self-start text-sm text-violet-600 hover:underline dark:text-violet-400">
          + Add label
        </button>
      </div>

      <fieldset className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <legend className="px-1 text-sm font-medium text-gray-600 dark:text-gray-400">Profile links</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {LINK_FIELDS.map(({ platform, label, placeholder }) => (
            <ProfileLinkField key={platform} platform={platform} label={label} name={`link_${platform}`}
              placeholder={placeholder} defaultValue={initialLinks[platform] ?? ""} />
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label htmlFor="submitterNotes" className="text-sm font-medium">
          What changed and why? (optional)
        </label>
        <textarea
          id="submitterNotes"
          name="submitterNotes"
          placeholder="e.g. She moved from Berlin to London last year. New Instagram handle."
          rows={3}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
      </div>

      <Field
        label="Your email (required — we'll send a confirmation link)"
        name="submitterEmail"
        type="email"
        required
      />

      {/* ── Turnstile widget ────────────────────────────────────── */}
      {siteKey && (
        <Turnstile
          siteKey={siteKey}
          onSuccess={(token) => setTurnstileToken(token)}
          onError={() => setTurnstileToken(null)}
          onExpire={() => setTurnstileToken(null)}
          options={{ theme: "auto" }}
        />
      )}

      {status === "error" && (
        <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
      )}

      {/* ── Floating action bar ────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <button
            type="submit"
            disabled={status === "submitting" || (!!siteKey && !turnstileToken)}
            className="rounded-md bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {status === "submitting" ? "Submitting…" : "Submit revision"}
          </button>
          <a href={`/artist/${artist.id}`}
            className="rounded-md px-5 py-2 text-sm font-medium text-gray-600 hover:underline dark:text-gray-300">
            Cancel
          </a>
        </div>
      </div>
    </form>
  );
}

function Field({
  label, name, placeholder, required, type = "text", defaultValue,
}: {
  label: string; name: string; placeholder?: string;
  required?: boolean; type?: string; defaultValue?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium">{label}</label>
      <input id={name} name={name} type={type} placeholder={placeholder}
        required={required} defaultValue={defaultValue}
        className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900" />
    </div>
  );
}
