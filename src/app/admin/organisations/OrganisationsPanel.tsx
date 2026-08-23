"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import type { OrganisationStatus } from "@/lib/types";
import {
  createOrganisation,
  setOrganisationStatus,
  approveOrganisations,
} from "./actions";

export interface OrganisationRow {
  id: string;
  name: string;
  status: OrganisationStatus;
  duplicate_of: string | null;
  artist_count: number;
  types: string[];
}

interface Props {
  organisations: OrganisationRow[];
}

const TABS: { status: OrganisationStatus; label: string }[] = [
  { status: "pending", label: "Pending" },
  { status: "approved", label: "Approved" },
  { status: "rejected", label: "Rejected" },
  { status: "deleted", label: "Deleted" },
];

// Same normalisation the database stores in name_search, so typing
// "ostgut ton" finds "Ostgut-Ton" without the punctuation having to match.
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export default function OrganisationsPanel({ organisations }: Props) {
  const [tab, setTab] = useState<OrganisationStatus>(
    organisations.some((o) => o.status === "pending") ? "pending" : "approved",
  );
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [isCreating, startCreating] = useTransition();
  const [isBulk, startBulk] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  const counts = useMemo(() => {
    const map = new Map<OrganisationStatus, number>();
    for (const org of organisations) map.set(org.status, (map.get(org.status) ?? 0) + 1);
    return map;
  }, [organisations]);

  const visible = useMemo(() => {
    const needle = normalize(filter);
    return organisations
      .filter((org) => org.status === tab)
      .filter((org) => !needle || normalize(org.name).includes(needle));
  }, [organisations, tab, filter]);

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startCreating(async () => {
      const result = await createOrganisation(formData);
      if ("error" in result) setError(result.error);
      else formRef.current?.reset();
    });
  }

  function handleStatus(id: string, status: OrganisationStatus) {
    setError(null);
    setBusyId(id);
    startTransition(async () => {
      const result = await setOrganisationStatus(id, status);
      if ("error" in result) setError(result.error);
      setBusyId(null);
    });
  }

  // Bulk-approve exactly what is on screen, so a filtered view approves
  // what it shows and nothing else — the backfill's ~208 pending rows are
  // reviewed in batches, not one click at a time.
  function handleBulkApprove() {
    setError(null);
    startBulk(async () => {
      const result = await approveOrganisations(visible.map((o) => o.id));
      if ("error" in result) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ── Create ──────────────────────────────────────────────── */}
      <form ref={formRef} onSubmit={handleCreate} className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="new-organisation" className="text-sm font-medium">
            New organisation
          </label>
          <input
            id="new-organisation"
            name="name"
            type="text"
            placeholder="e.g. Ostgut Ton"
            required
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </div>
        <button
          type="submit"
          disabled={isCreating}
          className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
        >
          {isCreating ? "Adding…" : "Add"}
        </button>
      </form>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* ── Status tabs ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map(({ status, label }) => (
          <button
            key={status}
            type="button"
            onClick={() => setTab(status)}
            className={
              tab === status
                ? "rounded-full bg-violet-600 px-3 py-1 text-xs font-medium text-white"
                : "rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            }
          >
            {label} · {counts.get(status) ?? 0}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name…"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
        {tab === "pending" && visible.length > 0 && (
          <button
            type="button"
            onClick={handleBulkApprove}
            disabled={isBulk}
            className="shrink-0 rounded-md border border-emerald-300 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-60 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950"
          >
            {isBulk ? "Approving…" : `Approve these ${visible.length}`}
          </button>
        )}
      </div>

      {/* ── List ────────────────────────────────────────────────── */}
      {visible.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {filter ? "No matches." : "Nothing here."}
        </p>
      ) : (
        <div className="rounded-md border border-gray-100 dark:border-gray-800">
          {visible.map((org) => (
            <div
              key={org.id}
              className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 text-sm last:border-b-0 dark:border-gray-800"
            >
              <div className="min-w-0">
                <Link
                  href={`/admin/organisations/${org.id}`}
                  className="font-medium text-violet-600 hover:underline dark:text-violet-400"
                >
                  {org.name}
                </Link>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {org.artist_count} artist{org.artist_count === 1 ? "" : "s"}
                  {org.types.length > 0 && ` · ${org.types.join(", ")}`}
                  {org.types.length === 0 && " · no type yet"}
                  {org.duplicate_of && " · merged into another organisation"}
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                {org.status !== "approved" && (
                  <button
                    type="button"
                    onClick={() => handleStatus(org.id, "approved")}
                    disabled={busyId === org.id}
                    className="rounded px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30"
                  >
                    Approve
                  </button>
                )}
                {org.status !== "rejected" && (
                  <button
                    type="button"
                    onClick={() => handleStatus(org.id, "rejected")}
                    disabled={busyId === org.id}
                    className="rounded px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:text-amber-400 dark:hover:bg-amber-900/30"
                  >
                    Reject
                  </button>
                )}
                {org.status !== "deleted" ? (
                  <button
                    type="button"
                    onClick={() => handleStatus(org.id, "deleted")}
                    disabled={busyId === org.id}
                    className="rounded px-2 py-0.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-900/30"
                  >
                    Delete
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleStatus(org.id, "pending")}
                    disabled={busyId === org.id}
                    className="rounded px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    Restore
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
