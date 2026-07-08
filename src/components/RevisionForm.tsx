"use client";

import { useState, useRef, FormEvent } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import type { LinkPlatform, Platform, ArtistWithRelations } from "@/lib/types";
import TextList from "./form/TextList";
import GenreList from "./form/GenreList";
import LocationList, { type LocationRow } from "./form/LocationList";
import ProfileLinksFieldset from "./form/ProfileLinksFieldset";
import Field from "./form/Field";
import TextArea from "./form/TextArea";
import { mergeGenreOptions } from "@/lib/genre-options";

interface Props {
  artist: ArtistWithRelations;
  genreOptions: string[];
  platforms: Platform[];
}

type Status = "idle" | "submitting" | "success" | "needsVerification" | "error";

export default function RevisionForm({ artist, genreOptions, platforms }: Props) {
  // Pre-populate with existing artist data
  const [genres, setGenres] = useState<string[]>(
    artist.genres?.length ? artist.genres.map((g) => g.name) : [""]
  );
  const [locations, setLocations] = useState<LocationRow[]>(
    artist.locations?.length
      ? artist.locations.map((l) => ({ city: l.city ?? "", country: l.country ?? "" }))
      : [{ city: "", country: "" }]
  );
  const [labelList, setLabelList] = useState<string[]>(
    artist.label_list?.length ? artist.label_list.map((l) => l.name) : [""]
  );
  const [aliasNames, setAliasNames] = useState<string[]>(
    artist.aliases?.length ? artist.aliases.map((a) => a.name) : [""]
  );
  const [linkUrls, setLinkUrls] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const link of artist.links ?? []) {
      if (link.url && !link.not_found) {
        map[link.platform] = link.original_url ?? link.url ?? "";
      }
    }
    return map;
  });

  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function updateLinkUrl(platform: LinkPlatform, url: string) {
    setLinkUrls((prev) => ({ ...prev, [platform]: url }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);

    const form = e.currentTarget;
    const data = new FormData(form);

    const links: Partial<Record<LinkPlatform, string>> = {};
    for (const p of platforms) {
      const value = linkUrls[p.key]?.trim();
      if (value) links[p.key] = value;
    }

    const revisionData = {
      name: (data.get("name") as string | null)?.trim() || undefined,
      pronouns: (data.get("pronouns") as string | null)?.trim() || undefined,
      genres: genres.filter(Boolean).length ? genres.filter(Boolean) : undefined,
      locations: locations.filter((l) => l.city || l.country).length
        ? locations.filter((l) => l.city || l.country)
        : undefined,
      labels: labelList.filter(Boolean).length ? labelList.filter(Boolean) : undefined,
      aliases: aliasNames.filter(Boolean).length ? aliasNames.filter(Boolean) : undefined,
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

  const mergedGenreOptions = mergeGenreOptions(genreOptions, artist);

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

      <Field label="Name" name="name" required defaultValue={artist.name} />

      <TextList label="Aliases" itemNoun="alias" values={aliasNames} onChange={setAliasNames}
        placeholder="e.g. DJ Name, Former name" />

      <Field label="Pronouns" name="pronouns" placeholder="e.g. she/her"
        defaultValue={artist.pronoun?.value ?? ""} />

      <fieldset className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <legend className="px-1 text-sm font-medium text-gray-600 dark:text-gray-400">Location</legend>
        <LocationList values={locations} onChange={setLocations} />
      </fieldset>

      <GenreList label="Genres" values={genres} onChange={setGenres} options={mergedGenreOptions} />

      <TextList label="Labels / crews" itemNoun="label" values={labelList} onChange={setLabelList}
        placeholder="e.g. Ostgut Ton" />

      <fieldset className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <legend className="px-1 text-sm font-medium text-gray-600 dark:text-gray-400">Profile links</legend>
        <ProfileLinksFieldset platforms={platforms} values={linkUrls} onChange={updateLinkUrl} />
      </fieldset>

      <TextArea
        label="What changed and why? (optional)"
        name="submitterNotes"
        placeholder="e.g. She moved from Berlin to London last year. New Instagram handle."
        rows={3}
      />

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
