import type { GenerationAdapterId } from '@cultivation/domain';

/** Presentation for the fixed trusted adapter catalog. No renderer-supplied executable config. */
export const generationAdapters: Array<{
  id: GenerationAdapterId;
  label: string;
  endpoint: string;
}> = [
  { id: 'GEN_HTTP_V1', label: '通用生成服务', endpoint: '' },
  { id: 'APIMART_ASYNC', label: 'API Mart', endpoint: 'https://api.apimart.ai/v1' },
  { id: 'MIMO_TTS', label: '小米 MiMo 语音', endpoint: 'https://api.xiaomimimo.com/v1' },
  { id: 'TOKENRHYTHM_ASYNC', label: 'TokenRhythm', endpoint: 'https://tokenrhythm.studio/v1' },
  { id: 'H3', label: 'MiniMax H3（旧协议）', endpoint: '' },
];
