"use client";

import { useState, useTransition } from "react";
import type {
  LinkPlatform,
  Organisation,
  OrganisationLink,
  OrganisationLocation,
  OrganisationStatus,
  OrganisationType,
  Platform,
} from "@/lib/types";
import ProfileLinksFieldset from "@/components/form/ProfileLinksFieldset";
import LocationList, { type LocationRow } from "@/components/form/LocationList";
import { saveOrganisation } from "./actions";

interface Props {
  organisation: Organisation;
  selectedTypes: string[];
  locations: OrganisationLocation[];
  links: OrganisationLink[];
  types: OrganisationType[];
  platforms: Platform[];
}

const STATUSES: OrganisationStatus[] = ["pending", "approved", "rejected", "deleted"];

/**
 * The organisation detail form. Types, locations and links are held in
 * local state and posted as JSON, then replaced wholesale server-side —
 * the same shape the artist edit form uses, and the reason the link and
 * location widgets can be reused unchanged.
 */
export default function OrganisationEditForm({
  organisation,
  selectedTypes,
  locations,
  links,
  types,
  platforms,
}: Props) {
  const [name, setName] = useState(organisation.name);
  const [status, setStatus] = useState<OrganisationStatus>(organisation.status);
  const [description, setDescription] = useState(organisation.description ?? "");
  const [runByText, setRunByText] = useState(organisation.run_by_text ?? "");
  const [notes, setNotes] = useState(organisation.notes ?? "");
  const [typeKeys, setTypeKeys] = useState<string[]>(selectedTypes);
  const [locationRows, setLocationRows] = useState<LocationRow[]>(
    locations.length > 0
      ? locations.map((l) => ({ city: l.city ?? "", country: l.country ?? "" }))
      : [{ city: "", country: "" }],
  );
  const [linkValues, setLinkValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(links.map((l) => [l.platform, l.original_url ?? l.url ?? ""])),
  );
  const [notFound, setNotFound] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(links.map((l) => [l.platform, l.not_found])),
  );

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isSaving, startSaving] = useTransition();

  function toggleType(key: string) {
    setTypeKeys((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    const formData = new FormData();
    formData.set("id", organisation.id);
    formData.set("name", name);
    formData.set("status", status);
    formData.set("description", description);
    formData.set("run_by_text", runByText);
    formData.set("notes", notes);
    formData.set("types", JSON.stringify(typeKeys));
    formData.set(
      "locations",
      JSON.stringify(locationRows.filter((l) => l.city.trim() || l.country.trim())),
    );
    formData.set(
      "links",
      JSON.stringify(
        platforms
          .map((p) => ({
            platform: p.key as LinkPlatform,
            url: linkValues[p.key]?.trim() || null,
            not_found: notFound[p.key] ?? false,
          }))
          .filter((l) => l.url || l.not_found),
      ),
    );

    startSaving(async () => {
      const result = await saveOrganisation(formData);
      if ("error" in result) setError(result.error);
      else setSaved(true);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-1">
          <label htmlFor="organisation-name" className="text-sm font-medium">
            Name
          </label>
          <input
            id="organisation-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="organisation-status" className="text-sm font-medium">
            Status
          </label>
          <select
            id="organisation-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as OrganisationStatus)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Types ───────────────────────────────────────────────── */}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Types</legend>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Pick as many as apply — Tresor is a club and a label.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {types.map((type) => {
            const active = typeKeys.includes(type.key);
            return (
              <button
                key={type.key}
                type="button"
                onClick={() => toggleType(type.key)}
                aria-pressed={active}
                className={
                  active
                    ? "rounded-full bg-violet-600 px-3 py-1 text-xs font-medium text-white"
                    : "rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                }
              >
                {type.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* ── Locations ───────────────────────────────────────────── */}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Locations</legend>
        <LocationList values={locationRows} onChange={setLocationRows} />
      </fieldset>

      {/* ── Links ───────────────────────────────────────────────── */}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Links</legend>
        <ProfileLinksFieldset
          platforms={platforms}
          values={linkValues}
          onChange={(platform, value) =>
            setLinkValues((current) => ({ ...current, [platform]: value }))
          }
          notFound={notFound}
          onNotFoundChange={(platform, checked) =>
            setNotFound((current) => ({ ...current, [platform]: checked }))
          }
        />
      </fieldset>

      <div className="flex flex-col gap-1">
        <label htmlFor="organisation-run-by" className="text-sm font-medium">
          Run by <span className="font-normal text-gray-500">(free text)</span>
        </label>
        <input
          id="organisation-run-by"
          value={runByText}
          onChange={(e) => setRunByText(e.target.value)}
          placeholder="People who run it and aren't in the directory"
          className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="organisation-description" className="text-sm font-medium">
          Description <span className="font-normal text-gray-500">(public, optional)</span>
        </label>
        <textarea
          id="organisation-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="organisation-notes" className="text-sm font-medium">
          Notes <span className="font-normal text-gray-500">(admin only — never shown publicly)</span>
        </label>
        <textarea
          id="organisation-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {saved && <p className="text-sm text-green-600 dark:text-green-400">Saved.</p>}

      <button
        type="submit"
        disabled={isSaving}
        className="self-start rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
      >
        {isSaving ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
