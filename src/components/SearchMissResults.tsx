"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useRef, useState, FormEvent } from "react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";

interface Props {
  searchTerm: string;
  /** Whether the miss came from an exact-match search. */
  exact?: boolean;
}

type SubmitState = "idle" | "submitting" | "submitted" | "exists" | "error";

export default function SearchMissResults({ searchTerm, exact = false }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [trackedTerm, setTrackedTerm] = useState(searchTerm);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance>(null);

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  // Reset as soon as the search term changes, during render rather than in
  // an effect — avoids an extra render pass.
  if (searchTerm !== trackedTerm) {
    setTrackedTerm(searchTerm);
    setSubmitState("idle");
  }

  // Saving the searched name to the review queue only happens if the visitor
  // clicks the submit button below.
  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitState("submitting");

    const honeypot = new FormData(e.currentTarget).get("_hp");

    try {
      const res = await fetch("/api/search-miss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchTerm, turnstileToken, honeypot }),
      });

      if (!res.ok) {
        setSubmitState("error");
        return;
      }

      const data = await res.json();
      setSubmitState(data.alreadyExists ? "exists" : "submitted");
    } catch {
      setSubmitState("error");
    } finally {
      // Tokens are single-use: fetch a fresh one so a follow-up submission
      // (new search term, or retry after an error) isn't sent with a token
      // the server has already consumed.
      setTurnstileToken(null);
      turnstileRef.current?.reset();
    }
  }

  // Same search with the exact-match constraint lifted. An exact miss often
  // just means the visitor typed part of a longer name, so offer the wider
  // search before offering to add the name to the review queue.
  const broaderParams = new URLSearchParams(searchParams.toString());
  broaderParams.delete("exact");
  broaderParams.delete("page");
  const broaderHref = `${pathname}?${broaderParams.toString()}`;

  return (
    <div className="mt-2">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No artists {exact ? "named exactly" : "named"}{" "}
        <span className="font-semibold text-gray-800 dark:text-gray-200">
          &ldquo;{searchTerm}&rdquo;
        </span>{" "}
        are in the directory yet.
      </p>

      {exact && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          <Link
            href={broaderHref}
            className="text-violet-600 underline hover:no-underline dark:text-[#ff2d9b]"
          >
            Search every name containing &ldquo;{searchTerm}&rdquo;
          </Link>{" "}
          instead, or add it below.
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-3">
        {/* ── Honeypot (hidden from humans, filled by bots) ───────── */}
        <div style={{ position: "absolute", opacity: 0, height: 0, overflow: "hidden", pointerEvents: "none" }} aria-hidden="true">
          <label htmlFor="search-miss-hp">Website</label>
          <input id="search-miss-hp" name="_hp" type="text" tabIndex={-1} autoComplete="off" />
        </div>

        {(submitState === "idle" || submitState === "submitting") && (
          <button
            type="submit"
            disabled={submitState === "submitting" || (!!siteKey && !turnstileToken)}
            className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {submitState === "submitting"
              ? "Submitting…"
              : `Submit “${searchTerm}” for review`}
          </button>
        )}

        {/* Turnstile stays mounted across submissions so reset() can fetch a
            fresh token; it renders invisibly for most visitors. */}
        {siteKey && (
          <Turnstile
            ref={turnstileRef}
            siteKey={siteKey}
            onSuccess={(token) => setTurnstileToken(token)}
            onError={() => setTurnstileToken(null)}
            onExpire={() => setTurnstileToken(null)}
            options={{ theme: "auto" }}
            className="mt-3"
          />
        )}
      </form>

      <div className="mt-3">
        {submitState === "submitted" && (
          <p className="text-sm text-green-600 dark:text-green-400">
            Thanks — we&apos;ve added &ldquo;{searchTerm}&rdquo; to our review queue.
          </p>
        )}

        {submitState === "exists" && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            That name is already in our records and awaiting review.
          </p>
        )}

        {submitState === "error" && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Something went wrong submitting that — please try again.
          </p>
        )}
      </div>
    </div>
  );
}
