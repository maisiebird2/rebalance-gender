// Types for failures.mjs. The runtime module is plain .mjs so that both
// plain-node scripts and the TS/Next side can import it; this file gives
// the TS side literal types instead of bare `string`.

export declare const IMAGE_FAILURE_SERVICE_PREFIX: "image:";

export declare function imageFailureService(platform: string): string;

export declare function platformFromImageFailureService(service: string): string | null;

export declare const IMAGE_FAILURE_STATUS: {
  readonly NO_IMAGE: "no_image";
  readonly NO_IMAGE_TAG: "no_image_tag";
  readonly PLACEHOLDER: "placeholder";
  readonly UNREACHABLE: "unreachable";
  readonly FETCH_FAILED: "fetch_failed";
  readonly WRITE_FAILED: "write_failed";
};

export type ImageFailureStatus =
  (typeof IMAGE_FAILURE_STATUS)[keyof typeof IMAGE_FAILURE_STATUS];

export declare function isDefinitiveImageFailure(status: string): boolean;

export declare function isTransientImageFailure(status: string): boolean;

export declare const LEGACY_IMAGE_FAILURE_SERVICE_PREFIXES: readonly string[];
