"use client";

import { useId, useMemo } from "react";
import { normalisedNameKey } from "@/lib/organisations";
import type { OrganisationSummary } from "@/lib/types";

/**
 * One row's value: an existing organisation, or a name nobody has matched yet.
 *
 * `id` is set when the typed text resolves to an approved organisation, and
 * null otherwise. The parent posts both shapes; the server attaches the
 * resolved ones straight away and holds the rest until an admin approves the
 * artist (see documentation/PROPOSAL-organisations.md §7).
 */
export interface OrganisationRow {
  id: string | null;
  name: string;
}

interface Props {
  /** Small heading shown above the rows. */
  label?: string;
  values: OrganisationRow[];
  onChange: (values: OrganisationRow[]) => void;
  /** Approved organisations, offered as suggestions. */
  options: OrganisationSummary[];
}

const EMPTY: OrganisationRow = { id: null, name: "" };

/**
 * A repeatable list of organisation inputs — the replacement for the
 * free-text `TextList` on "Labels / crews".
 *
 * Deliberately a native <input list> + <datalist> rather than a custom
 * dropdown. It gives type-ahead over the approved organisations, still
 * accepts a name that isn't in the list (which is the whole point — new
 * labels and crews have to be nameable), works on mobile and with a
 * keyboard for free, and needs no open/closed state of its own. The trade
 * is that the suggestion list isn't stylable; for a list of names that is
 * a fair price.
 *
 * Matching is by normalised name, the same key the database uses, so
 * "ostgut ton" resolves to the existing "Ostgut Ton" instead of quietly
 * proposing a second row that differs only in case.
 */
export default function OrganisationList({ label, values, onChange, options }: Props) {
  const listId = useId();
  const rows = values.length > 0 ? values : [EMPTY];

  const byKey = useMemo(() => {
    const map = new Map<string, OrganisationSummary>();
    for (const option of options) {
      const key = normalisedNameKey(option.name);
      if (key && !map.has(key)) map.set(key, option);
    }
    return map;
  }, [options]);

  function update(i: number, name: string) {
    const matched = byKey.get(normalisedNameKey(name));
    onChange(
      rows.map((row, idx) =>
        idx === i
          ? // Snap to the existing organisation's own spelling when it
            // matches, so the submitter can see they picked the real one.
            matched
            ? { id: matched.id, name: matched.name }
            : { id: null, name }
          : row,
      ),
    );
  }
  function add() {
    onChange([...rows, { ...EMPTY }]);
  }
  function remove(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    onChange(next.length > 0 ? next : [{ ...EMPTY }]);
  }

  return (
    <div className="flex flex-col gap-2">
      {label && <span className="text-sm font-medium">{label}</span>}

      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.id} value={option.name} />
        ))}
      </datalist>

      {rows.map((row, i) => (
        <div key={i} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <input
              type="text"
              list={listId}
              value={row.name}
              onChange={(e) => update(i, e.target.value)}
              placeholder="Label, club, crew or event"
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
            />
            {rows.length > 1 && (
              <button
                type="button"
                onClick={() => remove(i)}
                className="rounded-md px-2 py-2 text-sm text-gray-400 hover:text-red-500"
                aria-label="Remove organisation"
              >
                ✕
              </button>
            )}
          </div>
          {row.name.trim() !== "" && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {row.id
                ? "Matches an existing entry."
                : "New — it'll be added once a moderator has looked at it."}
            </p>
          )}
        </div>
      ))}

      <button
        type="button"
        onClick={add}
        className="self-start text-sm text-violet-600 hover:underline dark:text-violet-400"
      >
        + Add label / crew
      </button>
    </div>
  );
}
