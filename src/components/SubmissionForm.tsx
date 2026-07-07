"use client";

import { useState, useRef, FormEvent } from "react";
import Link from "next/link";
import { Turnstile } from "@marsidev/react-turnstile";
import type { LinkPlatform, Platform } from "@/lib/types";
import TextList from "./form/TextList";
import GenreList from "./form/GenreList";
import LocationList, { type LocationRow } from "./form/LocationList";
import ProfileLinksFieldset from "./form/ProfileLinksFieldset";
import Field from "./form/Field";

interface Props {
  genreOptions: string[];
  platforms: Platform[];
  isLoggedIn?: boolean;
}

type Status = "idle" | "submitting" | "success" | "needsVerification" | "error";

interface DuplicateMatch {
  id: string;
  name: string;
}

export default function SubmissionForm({ genreOptions, platforms, isLoggedIn = false }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [genres, setGenres] = useState<string[]>([""]);
  const [locations, setLocations] = useState<LocationRow[]>([{ city: "", country: "" }]);
  const [labelList, setLabelList] = useState<string[]>([""]);
  const [aliasNames, setAliasNames] = useState<string[]>([""]);
  const [linkUrls, setLinkUrls] = useState<Record<string, string>>({});
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function updateLinkUrl(platform: LinkPlatform, url: string) {
    setLinkUrls((prev) => ({ ...prev, [platform]: url }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    setErrorMessage(null);
    setDuplicates([]);

    const form = e.currentTarget;
    const data = new FormData(form);

    const links: Partial<Record<LinkPlatform, string>> = {};
    for (const p of platforms) {
      const value = linkUrls[p.key]?.trim();
      if (value) links[p.key] = value;
    }

    const payload = {
      name: data.get("name"),
      pronouns: data.get("pronouns"),
      genres: genres.filter(Boolean),
      locations: locations.filter((l) => l.city || l.country),
      labels: labelList.filter(Boolean),
      aliases: aliasNames.filter(Boolean),
      // Internal notes are only collected from logged-in admins.
      notes: isLoggedIn ? data.get("notes") : undefined,
      submittedByEmail: data.get("submittedByEmail"),
      links,
      turnstileToken,
      // honeypot — the value of this field; bots fill it, humans don't
      honeypot: data.get("_hp"),
    };

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (Array.isArray(body.duplicates)) {
          setDuplicates(body.duplicates as DuplicateMatch[]);
        }
        throw new Error(body.error || "Something went wrong");
      }

      if (body.requiresVerification) {
        setStatus("needsVerification");
      } else {
        setStatus("success");
      }
      form.reset();
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
          We&apos;ve sent you a confirmation link. Click it to send your submission to
          our review queue. The link expires in 48 hours.
        </p>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 p-4 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
        Thanks! Your submission has been received and will appear once it&apos;s reviewed.
      </div>
    );
  }

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-4 pb-20">

      {/* ── Honeypot (hidden from humans, filled by bots) ───────── */}
      <div style={{ position: "absolute", opacity: 0, height: 0, overflow: "hidden", pointerEvents: "none" }} aria-hidden="true">
        <label htmlFor="_hp">Website</label>
        <input id="_hp" name="_hp" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <Field label="Name" name="name" required />
      <Field label="Pronouns" name="pronouns" placeholder="e.g. she/her" />

      <TextList label="Aliases" itemNoun="alias" values={aliasNames} onChange={setAliasNames}
        placeholder="e.g. DJ Name, Former name" />

      <GenreList label="Genres" values={genres} onChange={setGenres} options={genreOptions} />

      <fieldset className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <legend className="px-1 text-sm font-medium text-gray-600 dark:text-gray-400">Location</legend>
        <LocationList values={locations} onChange={setLocations} />
      </fieldset>

      <TextList label="Labels / crews" itemNoun="label" values={labelList} onChange={setLabelList}
        placeholder="e.g. Ostgut Ton" />

      <fieldset className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
        <legend className="px-1 text-sm font-medium text-gray-600 dark:text-gray-400">Profile links</legend>
        <ProfileLinksFieldset platforms={platforms} values={linkUrls} onChange={updateLinkUrl} />
      </fieldset>

      {isLoggedIn && (
        <div className="flex flex-col gap-1">
          <label htmlFor="notes" className="text-sm font-medium">
            Internal notes <span className="font-normal text-gray-500">(admin only — never shown publicly)</span>
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            placeholder="Private notes for reviewers."
            className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </div>
      )}

      {!isLoggedIn && (
        <Field
          label="Your email (required — we'll send a confirmation link)"
          name="submittedByEmail"
          type="email"
          required
        />
      )}

      {/* ── Turnstile widget (not shown to logged-in admins) ────── */}
      {siteKey && !isLoggedIn && (
        <Turnstile
          siteKey={siteKey}
          onSuccess={(token) => setTurnstileToken(token)}
          onError={() => setTurnstileToken(null)}
          onExpire={() => setTurnstileToken(null)}
          options={{ theme: "auto" }}
        />
      )}

      {status === "error" && (
        <div className="text-sm text-red-600 dark:text-red-400">
          <p>{errorMessage}</p>
          {duplicates.length > 0 && (
            <p className="mt-1">
              {duplicates.length === 1 ? "See the existing entry: " : "See the existing entries: "}
              {duplicates.map((d, i) => (
                <span key={d.id}>
                  {i > 0 && ", "}
                  <Link
                    href={`/artist/${d.id}`}
                    target="_blank"
                    className="font-medium underline hover:no-underline"
                  >
                    {d.name}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </div>
      )}

      {/* ── Floating action bar ────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <button
            type="submit"
            disabled={status === "submitting" || (!isLoggedIn && !!siteKey && !turnstileToken)}
            className="rounded-md bg-violet-600 px-5 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {status === "submitting" ? "Submitting…" : "Submit"}
          </button>
          <Link href="/" className="rounded-md px-5 py-2 text-sm font-medium text-gray-600 hover:underline dark:text-gray-300">
            Cancel
          </Link>
        </div>
      </div>
    </form>
  );
}
