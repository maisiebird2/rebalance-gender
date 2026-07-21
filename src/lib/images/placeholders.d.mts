// Types for placeholders.mjs — see failures.d.mts for why the runtime
// module is plain .mjs.

export declare function isPlaceholderImageUrl(
  imageUrl: unknown,
  platform?: string
): boolean;

export declare function describePlaceholderImageUrl(
  imageUrl: unknown,
  platform?: string
): string | null;
