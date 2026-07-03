"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  quickApprove,
  quickReject,
  quickMarkNotEligible,
  approveRevision,
  rejectRevision,
} from "./actions";
import type { ArtistWithRelations, ArtistRevision } from "@/lib/types";

type RevisionWithArtist = ArtistRevision & { artist: { id: string; name: string } };

export type SubmissionKind = "submission" | "search_input" | "revision";

export interface SubmissionItem {
  kind: SubmissionKind;
  /** ISO date used for sorting (submitted_at / created_at) */
  sortDate: string;
  artist?: ArtistWithRelations;
  revision?: RevisionWithArtist;
}

const PAGE_SIZE = 20;

const KIND_LABEL: Record<SubmissionKind, string> = {
  submission: "Submission",
  search_input: "Search input",
  revision: "Revision",
};

const KIND_TAG_CLASSES: Record<SubmissionKind, string> = {
  submission: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  search_input: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  revision: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200",
};

function KindTag({ kind }: { kind: SubmissionKind }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${KIND_TAG_CLASSES[kind]}`}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 py-10 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
      {label}
    </div>
  );
}

export default function SubmissionsPanel({ items }: { items: SubmissionItem[] }) {
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activeKinds, setActiveKinds] = useState<Set<SubmissionKind>>(
    new Set(["submission", "search_input", "revision"])
  );
  const [page, setPage] = useState(1);

  const counts = useMemo(() => {
    const c: Record<SubmissionKind, number> = { submission: 0, search_input: 0, revision: 0 };
    for (const item of items) c[item.kind]++;
    return c;
  }, [items]);

  const filtered = useMemo(
    () => items.filter((item) => activeKinds.has(item.kind)),
    [items, activeKinds]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  function toggleKind(kind: SubmissionKind) {
    setPage(1);
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) {
        next.delete(kind);
      } else {
        next.add(kind);
      }
      // Don't allow an empty filter — fall back to showing everything.
      return next.size === 0 ? new Set(["submission", "search_input", "revision"]) : next;
    });
  }

  function runAction(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    startTransition(async () => {
      await fn();
      setBusyId(null);
    });
  }

  return (
    <div>
      <div className="mb-3">
        <h2 className="text-lg font-semibold">Pending submissions</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {items.length === 0
            ? "No pending submissions"
            : `${items.length} pending ${items.length === 1 ? "item" : "items"}`}
        </p>
      </div>

      {/* ── Type filter ─────────────────────────────────────────── */}
      {items.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {(["submission", "search_input", "revision"] as SubmissionKind[]).map((kind) => {
            const active = activeKinds.has(kind);
            return (
              <button
                key={kind}
                onClick={() => toggleKind(kind)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  active
                    ? KIND_TAG_CLASSES[kind] + " border-transparent"
                    : "border-gray-300 text-gray-400 hover:border-gray-400 dark:border-gray-700 dark:text-gray-500"
                }`}
              >
                {KIND_LABEL[kind]} ({counts[kind]})
              </button>
            );
          })}
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState label="No pending submissions" />
      ) : filtered.length === 0 ? (
        <EmptyState label="No submissions match the selected filters" />
      ) : (
        <>
          <div className="flex flex-col gap-4">
            {pageItems.map((item) =>
              item.kind === "revision" ? (
                <RevisionCard
                  key={`revision-${item.revision!.id}`}
                  revision={item.revision!}
                  busy={busyId === item.revision!.id}
                  onApprove={() =>
                    runAction(item.revision!.id, () => approveRevision(item.revision!.id))
                  }
                  onReject={() =>
                    runAction(item.revision!.id, () => rejectRevision(item.revision!.id))
                  }
                />
              ) : (
                <SubmissionCard
                  key={`${item.kind}-${item.artist!.id}`}
                  kind={item.kind}
                  artist={item.artist!}
                  busy={busyId === item.artist!.id}
                  onApprove={() =>
                    runAction(item.artist!.id, () => quickApprove(item.artist!.id))
                  }
                  onReject={() =>
                    runAction(item.artist!.id, () => quickReject(item.artist!.id))
                  }
                  onNotEligible={() =>
                    runAction(item.artist!.id, () => quickMarkNotEligible(item.artist!.id))
                  }
                />
              )
            )}
          </div>

          {totalPages > 1 && (
            <div className="mt-5 flex items-center justify-between text-sm">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={clampedPage <= 1}
                className="rounded-md border border-gray-300 px-3 py-1.5 font-medium hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                ← Previous
              </button>
              <span className="text-gray-500 dark:text-gray-400">
                Page {clampedPage} of {totalPages} &middot; {filtered.length} total
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={clampedPage >= totalPages}
                className="rounded-md border border-gray-300 px-3 py-1.5 font-medium hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SubmissionCard({
  kind,
  artist,
  busy,
  onApprove,
  onReject,
  onNotEligible,
}: {
  kind: SubmissionKind;
  artist: ArtistWithRelations;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onNotEligible: () => void;
}) {
  const location = artist.locations?.[0];
  const locationStr = [location?.city, location?.country].filter(Boolean).join(", ");
  const genreStr = artist.genres?.map((g) => g.name).join(", ");
  const linkPlatforms = artist.links?.map((l) => l.platform).join(", ");
  const submittedAt = artist.submitted_at ?? artist.created_at;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex flex-col gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <KindTag kind={kind} />
            <h3 className="text-lg font-semibold">{artist.name}</h3>
            {artist.pronoun && (
              <span className="text-sm text-gray-500 dark:text-gray-400">{artist.pronoun.value}</span>
            )}
            <span className="text-xs text-gray-400 dark:text-gray-500">
              Submitted {formatDate(submittedAt)}
            </span>
          </div>

          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {locationStr && (<><dt className="text-gray-500 dark:text-gray-400">Location</dt><dd>{locationStr}</dd></>)}
            {genreStr && (<><dt className="text-gray-500 dark:text-gray-400">Genres</dt><dd>{genreStr}</dd></>)}
            {linkPlatforms && (<><dt className="text-gray-500 dark:text-gray-400">Links</dt><dd>{linkPlatforms}</dd></>)}
            {artist.label_list?.length > 0 && (
              <><dt className="text-gray-500 dark:text-gray-400">Labels</dt><dd>{artist.label_list.map((l) => l.name).join(", ")}</dd></>
            )}
            {artist.notes && (
              <><dt className="text-gray-500 dark:text-gray-400">Notes</dt><dd className="italic text-gray-600 dark:text-gray-400">{artist.notes}</dd></>
            )}
            {artist.submitted_by_email && (
              <><dt className="text-gray-500 dark:text-gray-400">From</dt><dd className="text-gray-600 dark:text-gray-400">{artist.submitted_by_email}</dd></>
            )}
          </dl>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link href={`/artist/${artist.id}/edit?from=admin`}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
            Review &amp; edit
          </Link>
          <button
            onClick={onApprove}
            disabled={busy}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50">
            Approve
          </button>
          <button
            onClick={onReject}
            disabled={busy}
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:hover:bg-red-950">
            Reject
          </button>
          <button
            onClick={onNotEligible}
            disabled={busy}
            className="rounded-md border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950">
            Not eligible
          </button>
        </div>
      </div>
    </div>
  );
}

function RevisionCard({
  revision,
  busy,
  onApprove,
  onReject,
}: {
  revision: RevisionWithArtist;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const rd = revision.revision_data;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex flex-col gap-3">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <KindTag kind="revision" />
            <Link href={`/artist/${revision.artist.id}`}
              className="text-base font-semibold text-violet-700 hover:underline dark:text-violet-400">
              {revision.artist.name}
            </Link>
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {formatDate(revision.created_at)}
            </span>
          </div>
          {revision.submitted_by_email && (
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              From: {revision.submitted_by_email}
            </p>
          )}
        </div>

        {/* Show proposed changes */}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {rd.name && (<><dt className="text-gray-500">Name</dt><dd>{rd.name}</dd></>)}
          {rd.pronouns && (<><dt className="text-gray-500">Pronouns</dt><dd>{rd.pronouns}</dd></>)}
          {rd.genres?.length && (
            <><dt className="text-gray-500">Genres</dt><dd>{rd.genres.join(", ")}</dd></>
          )}
          {rd.locations?.length && (
            <><dt className="text-gray-500">Locations</dt>
            <dd>{rd.locations.map((l) => [l.city, l.country].filter(Boolean).join(", ")).join(" | ")}</dd></>
          )}
          {rd.labels?.length && (<><dt className="text-gray-500">Labels</dt><dd>{rd.labels.join(", ")}</dd></>)}
          {rd.links && Object.keys(rd.links).length > 0 && (
            <><dt className="text-gray-500">Links</dt>
            <dd className="break-all">{Object.entries(rd.links).map(([k, v]) => `${k}: ${v}`).join("; ")}</dd></>
          )}
          {revision.submitter_notes && (
            <><dt className="text-gray-500">Notes</dt>
            <dd className="italic text-gray-600 dark:text-gray-400">{revision.submitter_notes}</dd></>
          )}
        </dl>

        <div className="flex flex-wrap gap-2">
          <Link href={`/artist/${revision.artist.id}/edit?from=admin`}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900">
            Review artist
          </Link>
          <button
            onClick={onApprove}
            disabled={busy}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50">
            Apply &amp; approve
          </button>
          <button
            onClick={onReject}
            disabled={busy}
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:hover:bg-red-950">
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
