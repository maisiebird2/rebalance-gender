"use client";

import { useId, useMemo } from "react";
import { normalisedNameKey } from "@/lib/name-key.mjs";
import type { OrganisationFormRow, OrganisationRole, OrganisationSummary } from "@/lib/types";

interface Props {
  /** Small heading shown above the rows. */
  label?: string;
  values: OrganisationFormRow[];
  onChange: (values: OrganisationFormRow[]) => void;
  /** Approved organisations, offered as suggestions. */
  options: OrganisationSummary[];
  /**
   * The role vocabulary. Supply it to show a per-row role picker — the
   * ADMIN edit form does, so any role can be set from the artist side
   * as well as from the organisation page.
   *
   * The public submit and revise forms omit it: a stranger should not be
   * asserting that somebody is head of a label. `associated` is the
   * ceiling there, and it is exactly what the old flat label text meant.
   * The server enforces that too — see resolveOrganisationInputs().
   */
  roles?: OrganisationRole[];
}

const DEFAULT_ROLE_KEY = "associated";
const EMPTY: OrganisationFormRow = { id: null, name: "", role_key: DEFAULT_ROLE_KEY };

/**
 * A repeatable list of organisation inputs — the Organisations field,
 * replacing the free-text `TextList` that used to be "Labels / crews".
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
export default function OrganisationList({ label, values, onChange, options, roles }: Props) {
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
            // The role is the row's own and survives a rename.
            matched
            ? { ...row, id: matched.id, name: matched.name }
            : { ...row, id: null, name }
          : row,
      ),
    );
  }
  function setRole(i: number, roleKey: string) {
    onChange(rows.map((row, idx) => (idx === i ? { ...row, role_key: roleKey } : row)));
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
            {roles && roles.length > 0 && (
              <select
                value={row.role_key ?? DEFAULT_ROLE_KEY}
                onChange={(e) => setRole(i, e.target.value)}
                aria-label="Role at this organisation"
                className="rounded-md border border-gray-300 px-2 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
              >
                {roles.map((role) => (
                  <option key={role.key} value={role.key}>
                    {role.label}
                  </option>
                ))}
              </select>
            )}
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
                : roles
                  ? "New — it'll be created for review, in the associated role. Set a different one once it exists."
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
