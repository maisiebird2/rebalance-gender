"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { addGenreTagRule, deleteGenreTagRule, type GenreTagRuleKind } from "./actions";

export interface GenreTagRule {
  id: number;
  kind: GenreTagRuleKind;
  raw_tag: string;
  canonical: string | null;
  note: string | null;
}

interface Props {
  rules: GenreTagRule[];
}

const KIND_LABELS: Record<GenreTagRuleKind, string> = {
  alias: "Aliases (raw tag → canonical name)",
  discard: "Discards (never a genre)",
  word_fix: "Word fixes (applied before alias lookup)",
};

export default function GenreTagRulesPanel({ rules }: Props) {
  const [, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [filter, setFilter] = useState("");

  // Add form state
  const [kind, setKind] = useState<GenreTagRuleKind>("alias");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isAdding, startAdding] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rules;
    return rules.filter(
      (r) =>
        r.raw_tag.includes(q) ||
        (r.canonical ?? "").toLowerCase().includes(q) ||
        (r.note ?? "").toLowerCase().includes(q)
    );
  }, [rules, filter]);

  const byKind = useMemo(() => {
    const groups: Record<GenreTagRuleKind, GenreTagRule[]> = {
      alias: [],
      discard: [],
      word_fix: [],
    };
    for (const r of filtered) groups[r.kind]?.push(r);
    for (const g of Object.values(groups)) {
      g.sort((a, b) => a.raw_tag.localeCompare(b.raw_tag));
    }
    return groups;
  }, [filtered]);

  function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const formData = new FormData(e.currentTarget);

    startAdding(async () => {
      const result = await addGenreTagRule(formData);
      if (result && "error" in result) {
        setError(result.error);
      } else {
        setSuccess(true);
        formRef.current?.reset();
        setKind("alias");
      }
    });
  }

  function handleDelete(id: number) {
    setPendingId(id);
    startTransition(async () => {
      await deleteGenreTagRule(id);
      setPendingId(null);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ── Add rule ────────────────────────────────────────────── */}
      <form ref={formRef} onSubmit={handleAdd} className="flex flex-col gap-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor="rule-kind" className="text-sm font-medium">
              Rule kind
            </label>
            <select
              id="rule-kind"
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as GenreTagRuleKind)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            >
              <option value="alias">alias — map a spelling to a canonical name</option>
              <option value="discard">discard — drop the tag entirely</option>
              <option value="word_fix">word fix — fix a word inside compound tags</option>
            </select>
          </div>
          <div>
            <label htmlFor="rule-raw" className="text-sm font-medium">
              {kind === "word_fix" ? "Word to replace" : "Raw tag"}
            </label>
            <input
              id="rule-raw"
              name="raw_tag"
              type="text"
              placeholder={kind === "word_fix" ? "e.g. avantgarde" : "e.g. dnb"}
              required
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </div>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            {kind !== "discard" && (
              <>
                <label htmlFor="rule-canonical" className="text-sm font-medium">
                  {kind === "word_fix" ? "Replacement" : "Canonical name"}
                </label>
                <input
                  id="rule-canonical"
                  name="canonical"
                  type="text"
                  placeholder={kind === "word_fix" ? "e.g. avant-garde" : "e.g. drum & bass"}
                  required
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
                />
              </>
            )}
          </div>
          <div className="flex-1">
            <label htmlFor="rule-note" className="text-sm font-medium">
              Note <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <input
              id="rule-note"
              name="note"
              type="text"
              placeholder="why this rule exists"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </div>
          <button
            type="submit"
            disabled={isAdding}
            className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
          >
            {isAdding ? "Adding…" : "Add rule"}
          </button>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {success && <p className="text-sm text-green-600 dark:text-green-400">Added.</p>}
      </form>

      {/* ── Filter ──────────────────────────────────────────────── */}
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={`Filter ${rules.length} rule(s)…`}
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
      />

      {/* ── Rule lists ──────────────────────────────────────────── */}
      {(Object.keys(KIND_LABELS) as GenreTagRuleKind[]).map((k) => (
        <div key={k}>
          <p className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            {KIND_LABELS[k]} · {byKind[k].length}
          </p>
          {byKind[k].length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {filter ? "No matches." : "None yet."}
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-md border border-gray-100 dark:border-gray-800">
              {byKind[k].map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-1.5 text-sm last:border-b-0 dark:border-gray-800"
                >
                  <div className="min-w-0">
                    <span className="font-mono text-xs">{r.raw_tag}</span>
                    {r.canonical && (
                      <span className="text-gray-500"> → <span className="font-mono text-xs">{r.canonical}</span></span>
                    )}
                    {r.note && (
                      <span className="ml-2 truncate text-xs text-gray-400" title={r.note}>
                        {r.note}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(r.id)}
                    disabled={pendingId === r.id}
                    className="shrink-0 rounded border border-red-300 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:hover:bg-red-950"
                  >
                    {pendingId === r.id ? "…" : "Delete"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
