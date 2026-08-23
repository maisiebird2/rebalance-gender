"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { OrganisationRole } from "@/lib/types";
import {
  addArtistAssociation,
  removeArtistAssociation,
  searchArtistsForAssociation,
} from "./actions";

export interface AssociationRow {
  artist_id: string;
  artist_name: string;
  artist_status: string;
  role_key: string;
  role_label: string;
}

interface Props {
  organisationId: string;
  associations: AssociationRow[];
  roles: OrganisationRole[];
}

interface ArtistHit {
  id: string;
  name: string;
  directory_status: string;
}

/**
 * Attach directory artists to this organisation, one row per role.
 *
 * The picker searches on the normalised name key rather than the raw
 * name, so "amo" finds "A.MO" — the same match the directory search
 * makes. Adding the same artist in a second role is an ordinary insert
 * (role_key is part of the primary key), which is how somebody ends up
 * correctly listed as both owner and resident.
 */
export default function ArtistAssociationsPanel({
  organisationId,
  associations,
  roles,
}: Props) {
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<ArtistHit[]>([]);
  const [selected, setSelected] = useState<ArtistHit | null>(null);
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? "associated");
  const [error, setError] = useState<string | null>(null);
  const [isSearching, startSearching] = useTransition();
  const [isAdding, startAdding] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [, startRemoving] = useTransition();

  function handleSearch() {
    const query = term.trim();
    if (!query) {
      setHits([]);
      return;
    }
    setError(null);
    startSearching(async () => {
      setHits(await searchArtistsForAssociation(query));
    });
  }

  function handleAdd() {
    if (!selected) return;
    setError(null);
    startAdding(async () => {
      const result = await addArtistAssociation(organisationId, selected.id, roleKey);
      if ("error" in result) {
        setError(result.error);
      } else {
        setSelected(null);
        setHits([]);
        setTerm("");
      }
    });
  }

  function handleRemove(row: AssociationRow) {
    setError(null);
    const id = `${row.artist_id}|${row.role_key}`;
    setBusy(id);
    startRemoving(async () => {
      const result = await removeArtistAssociation(organisationId, row.artist_id, row.role_key);
      if ("error" in result) setError(result.error);
      setBusy(null);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Existing ────────────────────────────────────────────── */}
      {associations.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No artists attached yet.</p>
      ) : (
        <div className="rounded-md border border-gray-100 dark:border-gray-800">
          {associations.map((row) => (
            <div
              key={`${row.artist_id}|${row.role_key}`}
              className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-1.5 text-sm last:border-b-0 dark:border-gray-800"
            >
              <div className="min-w-0">
                <Link
                  href={`/artist/${row.artist_id}`}
                  className="text-violet-600 hover:underline dark:text-violet-400"
                >
                  {row.artist_name}
                </Link>
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  {row.role_label} · {row.artist_status}
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(row)}
                disabled={busy === `${row.artist_id}|${row.role_key}`}
                className="shrink-0 rounded border border-red-300 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:hover:bg-red-950"
              >
                {busy === `${row.artist_id}|${row.role_key}` ? "…" : "Remove"}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Add ─────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 rounded-md border border-gray-100 p-3 dark:border-gray-800">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label htmlFor="association-search" className="text-sm font-medium">
              Add an artist
            </label>
            <input
              id="association-search"
              type="search"
              value={term}
              onChange={(e) => {
                setTerm(e.target.value);
                setSelected(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSearch();
                }
              }}
              placeholder="Search the directory by name…"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </div>
          <select
            value={roleKey}
            onChange={(e) => setRoleKey(e.target.value)}
            aria-label="Role"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            {roles.map((role) => (
              <option key={role.key} value={role.key}>
                {role.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleSearch}
            disabled={isSearching}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            {isSearching ? "…" : "Search"}
          </button>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!selected || isAdding}
            className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {isAdding ? "Adding…" : "Add"}
          </button>
        </div>

        {hits.length > 0 && (
          <div className="max-h-48 overflow-y-auto rounded-md border border-gray-100 dark:border-gray-800">
            {hits.map((hit) => (
              <button
                key={hit.id}
                type="button"
                onClick={() => setSelected(hit)}
                className={
                  selected?.id === hit.id
                    ? "flex w-full items-center justify-between gap-2 border-b border-gray-100 bg-violet-50 px-3 py-1.5 text-left text-sm last:border-b-0 dark:border-gray-800 dark:bg-violet-950/40"
                    : "flex w-full items-center justify-between gap-2 border-b border-gray-100 px-3 py-1.5 text-left text-sm last:border-b-0 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
                }
              >
                <span className="truncate">{hit.name}</span>
                <span className="shrink-0 text-xs text-gray-500">{hit.directory_status}</span>
              </button>
            ))}
          </div>
        )}
        {selected && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Adding <strong>{selected.name}</strong> as{" "}
            {roles.find((r) => r.key === roleKey)?.label ?? roleKey}.
          </p>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </div>
  );
}
