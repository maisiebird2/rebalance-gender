"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { BandcampAlbum } from "@/lib/types";

interface Props {
  albums: BandcampAlbum[];
  artistName: string;
}

const noopSubscribe = () => () => {};

/** True once mounted on the client. Lets us defer the random album pick
 *  until after hydration, avoiding an SSR/client mismatch. */
function useHasMounted() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

function pickRandomAlbum(albums: BandcampAlbum[]): BandcampAlbum | null {
  if (!albums.length) return null;
  const sorted = [...albums].sort((a, b) => a.sort_order - b.sort_order);
  return sorted[Math.floor(Math.random() * sorted.length)];
}

export default function BandcampWidget({ albums, artistName }: Props) {
  const hasMounted = useHasMounted();
  // Stay null until mounted so SSR and the initial client render match;
  // the random pick only happens after hydration.
  const album = useMemo(
    () => (hasMounted ? pickRandomAlbum(albums) : null),
    [hasMounted, albums]
  );

  if (!album) return null;

  const embedSrc =
    `https://bandcamp.com/EmbeddedPlayer` +
    `/${album.item_type}=${album.bandcamp_id}` +
    `/size=large/bgcol=333333/linkcol=ffffff/tracklist=false/artwork=small/transparent=true/`;

  return (
    <div className="mt-6">
      <h2 className="mb-2 text-lg font-semibold">
        On Bandcamp
        {album.title && (
          <span className="ml-2 text-sm font-normal text-gray-400">
            — {album.title}
          </span>
        )}
      </h2>
      <iframe
        title={`${album.title ?? artistName} on Bandcamp`}
        src={embedSrc}
        width="100%"
        height="120"
        seamless
        style={{ border: 0 }}
      />
    </div>
  );
}
