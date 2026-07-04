"use client";

/**
 * A repeatable list of genre <select> dropdowns. Fully controlled: the parent
 * owns the `values` array and receives a new array on every edit. Options are
 * the approved genre names passed down from the server.
 */
interface Props {
  /** Small heading shown above the rows. Omit when a parent <legend> already labels the group. */
  label?: string;
  values: string[];
  onChange: (values: string[]) => void;
  options: string[];
}

export default function GenreList({ label, values, onChange, options }: Props) {
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
      {rows.map((genre, i) => (
        <div key={i} className="flex items-center gap-2">
          <select
            value={genre}
            onChange={(e) => update(i, e.target.value)}
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            <option value="">— select a genre —</option>
            {options.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          {rows.length > 1 && (
            <button
              type="button"
              onClick={() => remove(i)}
              className="rounded-md px-2 py-2 text-sm text-gray-400 hover:text-red-500"
              aria-label="Remove genre"
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
        + Add genre
      </button>
    </div>
  );
}
