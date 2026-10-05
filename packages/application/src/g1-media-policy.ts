export type GenerationMediaCategory = 'IMAGE' | 'AUDIO' | 'VIDEO';
export type GenerationMediaDirection = 'input' | 'output';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Bump this value when a change alters the accepted media safety envelope. */
export const GENERATION_MEDIA_POLICY_VERSION = 'g1-media-v1' as const;

/** Shared, provider-neutral limits for generation media streams and metadata. */
export const GENERATION_MEDIA_POLICY = Object.freeze({
  version: GENERATION_MEDIA_POLICY_VERSION,
  ioChunkBytes: 64 * 1024,
  /** Reject a source that violates the requested bounded-chunk streaming contract. */
  maxSourceChunkBytes: 1024 * 1024,
  maxMetadataBytes: 8 * MiB,
  /** Streaming decompression stops before an image expands beyond this pixel envelope. */
  maxDecodedImageBytes: 256 * MiB,
  maxContainerRecords: 100_000,
  maxInputBytes: Object.freeze({
    IMAGE: 128 * MiB,
    AUDIO: 1 * GiB,
    VIDEO: 4 * GiB,
  }),
  maxOutputBytes: Object.freeze({
    IMAGE: 128 * MiB,
    AUDIO: 1 * GiB,
    VIDEO: 4 * GiB,
  }),
});

function kindCategory(kind: string): GenerationMediaCategory | null {
  const normalized = kind.trim().toUpperCase();
  for (const category of ['IMAGE', 'AUDIO', 'VIDEO'] as const) {
    if (normalized === category || normalized.startsWith(`${category}_`)) return category;
  }
  return null;
}

function mimeCategory(mimeType: string): GenerationMediaCategory | null {
  const normalized = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (normalized.startsWith('image/')) return 'IMAGE';
  if (normalized.startsWith('audio/')) return 'AUDIO';
  if (normalized.startsWith('video/')) return 'VIDEO';
  return null;
}

/** Returns null for unknown or conflicting kind/MIME metadata. */
export function generationMediaCategory(
  kind: string,
  mimeType: string,
): GenerationMediaCategory | null {
  const byKind = kindCategory(kind);
  const byMime = mimeCategory(mimeType);
  if (byKind && byMime && byKind !== byMime) return null;
  return byMime ?? byKind;
}

/** Resolve the application safety ceiling for one media category and direction. */
export function getGenerationMediaCeilingBytes(
  kind: string,
  mimeType: string,
  direction: GenerationMediaDirection,
): number | null {
  const category = generationMediaCategory(kind, mimeType);
  if (!category) return null;
  return direction === 'input'
    ? GENERATION_MEDIA_POLICY.maxInputBytes[category]
    : GENERATION_MEDIA_POLICY.maxOutputBytes[category];
}

/** Returns the UTF-8 size of JSON metadata, or null when it cannot be serialized. */
export function generationMetadataSizeBytes(value: unknown): number | null {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (serialized === undefined) return null;
  return new TextEncoder().encode(serialized).byteLength;
}

export function isGenerationMetadataWithinLimit(value: unknown): boolean {
  const sizeBytes = generationMetadataSizeBytes(value);
  return sizeBytes !== null && sizeBytes <= GENERATION_MEDIA_POLICY.maxMetadataBytes;
}
