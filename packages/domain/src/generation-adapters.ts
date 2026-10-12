/** Code-owned dispatch identifiers, never an executable plugin/REST configuration. */
export const GENERATION_ADAPTER_IDS = [
  'H3',
  'GEN_HTTP_V1',
  'APIMART_ASYNC',
  'MIMO_TTS',
  'TOKENRHYTHM_ASYNC',
] as const;
export type GenerationAdapterId = (typeof GENERATION_ADAPTER_IDS)[number];
export function isGenerationAdapterId(value: unknown): value is GenerationAdapterId {
  return typeof value === 'string' && GENERATION_ADAPTER_IDS.some((id) => id === value);
}
