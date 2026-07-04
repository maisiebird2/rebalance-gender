"use client";

/**
 * A repeatable list of single-line text inputs (e.g. labels/crews, aliases).
 * Fully controlled: the parent owns the `values` array and receives a new
 * array on every edit. Always renders at least one (possibly empty) row so
 * there is something to type into.
 *
 * Used by every form so a field like "Aliases" looks and behaves identically
 * whether you're submitting, revising, or editing an artist.
 */
interface Props {
  /** Small heading shown above the rows. Omit when a parent <legend> already labels the group. */
  label?: string;
  /** Noun used in the "+ Add {itemNoun}" button, e.g. "alias" → "+ Add alias". */
  itemNoun: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}

export default function TextList({ label, itemNoun, values, onChange, placeholder }: Props) {
  const rows = values.length > 0 ? values : [""];

  function update(i: number, value: string) {
    onChange(rows.map((v, idx) => (idx === i ? value : v)));
  }
  function add() {
    onChange([...rows, ""]);
  }
  function remove(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    onChange(next.length > 0 ? next : [""]);
  }

  return (
    <div className="flex flex-col gap-2">
      {label && <span className="text-sm font-medium">{label}</span>}
      {rows.map((value, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={value}
            onChange={(e) => update(i, e.target.value)}
            placeholder={placeholder}
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
          />
          {rows.length > 1 && (
            <button
              type="button"
              onClick={() => remove(i)}
              className="rounded-md px-2 py-2 text-sm text-gray-400 hover:text-red-500"
              aria-label={`Remove ${itemNoun}`}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="self-start text-sm text-violet-600 hover:underline dark:text-violet-400"
      >
        + Add {itemNoun}
      </button>
    </div>
  );
}
