import type { GenerationBinarySource } from '@cultivation/application/g1-generation';
import type { GenerationSubmissionRejectionCode } from '@cultivation/domain/g1-generation';

/** Trusted Main resolves credentials. Adapters never receive filesystem paths. */
export interface GenerationProviderRuntime {
  baseUrl: string;
  modelId: string;
  apiKey: string;
}
export type GenerationRuntimeResolver = (
  runtimeProfileId: string,
) => Promise<GenerationProviderRuntime | null>;

export interface GenerationUploadedInput {
  artifactId: string;
  role: string;
  fileId: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
}
export interface GenerationProviderSubmissionFact {
  runtimeId: string;
  key: string;
  requestFingerprint: string;
  semanticFingerprint: string;
  uploadedFiles: GenerationUploadedInput[];
  exactBody: string;
  phase: 'PREPARED' | 'SUBMITTING' | 'SUBMITTED' | 'REJECTED' | 'UNKNOWN';
  providerJobId: string | null;
  errorCode?: GenerationSubmissionRejectionCode | null;
}
export interface GenerationProviderStatePort {
  get(runtimeId: string, key: string): Promise<GenerationProviderSubmissionFact | null>;
  put(state: GenerationProviderSubmissionFact): Promise<void>;
}
export interface GenerationCachedMedia {
  mimeType?: string;
  sizeBytes: number;
  contentHash: string;
  source: GenerationBinarySource;
}
export interface GenerationProviderMediaCache {
  lookup(
    runtimeId: string,
    providerJobId: string,
    outputId: string,
  ): Promise<GenerationCachedMedia | null>;
  capture(input: {
    runtimeProfileId: string;
    providerJobId: string;
    outputId: string;
    mimeType: string;
    advertisedSize: number | null;
    source: GenerationBinarySource;
    signal?: AbortSignal;
  }): Promise<GenerationCachedMedia>;
}

export interface GenerationProviderHttpOptions {
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  /** Test composition may use loopback fixture hosts; never supplied by Renderer. */
  testOnly?: boolean;
}
