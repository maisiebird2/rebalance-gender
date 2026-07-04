"use client";

export interface LocationRow {
  city: string;
  country: string;
}

/**
 * A repeatable list of city/country pairs. Fully controlled: the parent owns
 * the `values` array and receives a new array on every edit. Always renders at
 * least one (possibly empty) row.
 */
interface Props {
  /** Small heading shown above the rows. Omit when a parent <legend> already labels the group. */
  label?: string;
  values: LocationRow[];
  onChange: (values: LocationRow[]) => void;
}

const EMPTY: LocationRow = { city: "", country: "" };

export default function LocationList({ label, values, onChange }: Props) {
  const rows = values.length > 0 ? values : [EMPTY];

  function update(i: number, field: keyof LocationRow, value: string) {
    onChange(rows.map((l, idx) => (idx === i ? { ...l, [field]: value } : l)));
  }
  function add() {
    onChange([...rows, { ...EMPTY }]);
  }
  function remove(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    onChange(next.length > 0 ? next : [{ ...EMPTY }]);
  }

  return (
    <div className="flex flex-col gap-3">
      {label && <span className="text-sm font-medium">{label}</span>}
      {rows.map((loc, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <div className="flex flex-col gap-1">
            {i === 0 && <span className="text-xs font-medium text-gray-500">City</span>}
            <input
              type="text"
              value={loc.city}
              onChange={(e) => update(i, "city", e.target.value)}
              placeholder="City"
              className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
            />
          </div>
          <div className="flex flex-col gap-1">
            {i === 0 && <span className="text-xs font-medium text-gray-500">Country</span>}
            <input
              type="text"
              value={loc.country}
              onChange={(e) => update(i, "country", e.target.value)}
              placeholder="Country"
              className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
            />
          </div>
          {rows.length > 1 && (
            <button
              type="button"
              onClick={() => remove(i)}
              className="mb-0.5 rounded-md px-2 py-2 text-sm text-gray-400 hover:text-red-500"
              aria-label="Remove location"
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
        + Add location
      </button>
    </div>
  );
}
