"use client";

import type { LinkPlatform, Platform } from "@/lib/types";
import { platformPlaceholder } from "@/lib/platforms";
import ProfileLinkField from "@/components/ProfileLinkField";

/**
 * The grid of per-platform profile-link inputs, shared by every form.
 *
 * Fully controlled via `values` (a platform-key → URL/handle map). The admin
 * edit form additionally passes `notFound` + `onNotFoundChange` to expose the
 * "Not found" checkbox (someone searched and confirmed the artist isn't on
 * that platform); the public submit/revise forms omit those props and the
 * checkbox is hidden.
 */
interface Props {
  platforms: Platform[];
  values: Record<string, string>;
  onChange: (platform: LinkPlatform, value: string) => void;
  /** When provided, renders a "Not found" checkbox per platform. */
  notFound?: Record<string, boolean>;
  onNotFoundChange?: (platform: LinkPlatform, checked: boolean) => void;
}

export default function ProfileLinksFieldset({
  platforms,
  values,
  onChange,
  notFound,
  onNotFoundChange,
}: Props) {
  const showNotFound = !!notFound && !!onNotFoundChange;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {platforms.map((p) => {
        const platform = p.key as LinkPlatform;
        const isNotFound = notFound?.[platform] ?? false;
        return (
          <div key={platform} className="flex flex-col gap-1">
            <ProfileLinkField
              platform={platform}
              label={p.label}
              name={`link_${platform}`}
              placeholder={platformPlaceholder(p.label)}
              value={values[platform] ?? ""}
              onChange={(v) => onChange(platform, v)}
              disabled={isNotFound}
            />
            {showNotFound && (
              <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={isNotFound}
                  onChange={(e) => onNotFoundChange!(platform, e.target.checked)}
                  className="rounded"
                />
                Not found
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}
