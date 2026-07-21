"use client";

import { useState } from "react";
import { normalizeProfileLink } from "@/lib/profile-links";

interface Props {
  platform: string;
  label: string;
  name: string;
  placeholder?: string;
  /** Uncontrolled usage (SubmissionForm, RevisionForm): initial value, read via FormData on submit. */
  defaultValue?: string;
  /** Controlled usage (EditForm): current value + change handler. */
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
}

/**
 * A profile-link input that accepts either a bare handle (e.g.
 * "techno_blondy") or a pasted profile URL, and normalizes it to the
 * platform's canonical URL on blur — showing what changed so the
 * conversion is never silent. The field stays a plain editable text
 * input throughout, so the person can correct the result if the
 * conversion guessed wrong.
 *
 * Normalization only applies to platforms lib/profile-links.ts has a
 * template for (soundcloud, instagram, tiktok, bandcamp,
 * resident_advisor); for everything else this behaves like a plain input.
 */
export default function ProfileLinkField({
  platform,
  label,
  name,
  placeholder,
  defaultValue,
  value,
  onChange,
  disabled,
}: Props) {
  const isControlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue ?? "");
  const current = isControlled ? value! : internalValue;

  const [note, setNote] = useState<{ tone: "info" | "warning"; text: string } | null>(null);

  function setValue(v: string) {
    if (isControlled) onChange?.(v);
    else setInternalValue(v);
  }

  function handleBlur() {
    const trimmed = current.trim();
    if (!trimmed) {
      setNote(null);
      return;
    }

    const result = normalizeProfileLink(platform, trimmed);

    if (result.url !== trimmed) {
      setValue(result.url);
    }

    if (result.warning) {
      setNote({ tone: "warning", text: result.warning });
    } else if (result.url !== trimmed) {
      setNote({ tone: "info", text: `Converted "${trimmed}" → ${result.url}` });
    } else {
      setNote(null);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="text"
        inputMode="url"
        value={current}
        onChange={(e) => {
          setValue(e.target.value);
          if (note) setNote(null);
        }}
        onBlur={handleBlur}
        placeholder={placeholder}
        disabled={disabled}
        className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-40 dark:border-gray-700 dark:bg-gray-900"
      />
      {note && (
        <p
          className={
            note.tone === "warning"
              ? "text-xs text-amber-600 dark:text-amber-400"
              : "text-xs text-gray-500 dark:text-gray-400"
          }
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
