"use client";

import { useRef, useState, useTransition } from "react";
import {
  addOrganisationVocabularyEntry,
  renameOrganisationVocabularyEntry,
  deleteOrganisationVocabularyEntry,
  type OrganisationVocabulary,
} from "./actions";

export interface VocabularyEntry {
  key: string;
  label: string;
  sort_order: number;
  /** How many rows point at this entry; drives the "in use" guard. */
  usage: number;
}

interface Props {
  kind: OrganisationVocabulary;
  entries: VocabularyEntry[];
  /** Placeholder for the add field, e.g. "e.g. distributor". */
  placeholder: string;
}

/**
 * The organisation role / type vocabulary editor, shown twice on
 * /admin/settings. Built as a copy of AddPlatformForm plus the two
 * things platforms don't need:
 *
 *   rename  in place, because role wording gets corrected ("A&R" typed
 *           as "AR") far more often than platform wording does. Only
 *           the label moves — the key stays, so existing rows follow.
 *   delete  guarded by the usage count. The FK is ON DELETE RESTRICT so
 *           the database refuses anyway; this says how many
 *           associations block it instead of showing a Postgres error.
 */
export default function OrganisationVocabularyPanel({ kind, entries, placeholder }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isAdding, startAdding] = useTransition();
  const [, startTransition] = useTransition();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  const noun = kind === "role" ? "role" : "type";

  function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const formData = new FormData(e.currentTarget);
    startAdding(async () => {
      const result = await addOrganisationVocabularyEntry(kind, formData);
      if ("error" in result) {
        setError(result.error);
      } else {
        setSuccess(true);
        formRef.current?.reset();
      }
    });
  }

  function startRename(entry: VocabularyEntry) {
    setError(null);
    setSuccess(false);
    setEditingKey(entry.key);
    setDraftLabel(entry.label);
  }

  function commitRename(key: string) {
    const label = draftLabel.trim();
    if (!label) {
      setEditingKey(null);
      return;
    }
    setBusyKey(key);
    startTransition(async () => {
      const result = await renameOrganisationVocabularyEntry(kind, key, label);
      if ("error" in result) setError(result.error);
      setBusyKey(null);
      setEditingKey(null);
    });
  }

  function handleDelete(entry: VocabularyEntry) {
    setError(null);
    setSuccess(false);
    setBusyKey(entry.key);
    startTransition(async () => {
      const result = await deleteOrganisationVocabularyEntry(kind, entry.key);
      if ("error" in result) setError(result.error);
      setBusyKey(null);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <form ref={formRef} onSubmit={handleAdd} className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor={`org-${kind}-label`} className="text-sm font-medium">
            New organisation {noun}
          </label>
          <input
            id={`org-${kind}-label`}
            name="label"
            type="text"
            placeholder={placeholder}
            required
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </div>
        <button
          type="submit"
          disabled={isAdding}
          className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
        >
          {isAdding ? "Adding…" : "Add"}
        </button>
      </form>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {success && <p className="text-sm text-green-600 dark:text-green-400">Added.</p>}

      {entries.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          None yet — the migration seeds these, so an empty list means they were deleted.
        </p>
      ) : (
        <div className="rounded-md border border-gray-100 dark:border-gray-800">
          {entries.map((entry) => (
            <div
              key={entry.key}
              className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-1.5 text-sm last:border-b-0 dark:border-gray-800"
            >
              {editingKey === entry.key ? (
                <input
                  autoFocus
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  onBlur={() => commitRename(entry.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(entry.key);
                    if (e.key === "Escape") setEditingKey(null);
                  }}
                  className="min-w-0 flex-1 rounded border border-violet-400 px-2 py-0.5 text-sm dark:bg-gray-900"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => startRename(entry)}
                  title="Rename (the key stays, so existing rows follow)"
                  className="min-w-0 flex-1 truncate text-left hover:text-violet-600 dark:hover:text-violet-400"
                >
                  {entry.label}
                  <span className="ml-2 font-mono text-xs text-gray-400">{entry.key}</span>
                </button>
              )}
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-gray-400">
                  {entry.usage} use{entry.usage === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  onClick={() => handleDelete(entry)}
                  disabled={busyKey === entry.key || entry.usage > 0}
                  title={
                    entry.usage > 0
                      ? `In use by ${entry.usage} association${entry.usage === 1 ? "" : "s"} — reassign those first`
                      : `Delete this ${noun}`
                  }
                  className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-800 dark:hover:bg-red-950"
                >
                  {busyKey === entry.key ? "…" : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
