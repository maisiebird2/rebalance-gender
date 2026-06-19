"use client";

import { useEffect, useState } from "react";
import type { BandcampAlbum } from "@/lib/types";

interface Props {
  albums: BandcampAlbum[];
  artistName: string;
}

export default function BandcampWidget({ albums, artistName }: Props) {
  // Start null so SSR and initial client render match, then pick randomly
  // after hydration via useEffect — avoids the SSR/client mismatch.
  const [album, setAlbum] = useState<BandcampAlbum | null>(null);

  useEffect(() => {
    if (!albums.length) return;
    const sorted = [...albums].sort((a, b) => a.sort_order - b.sort_order);
    setAlbum(sorted[Math.floor(Math.random() * sorted.length)]);
  }, [albums]);

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
