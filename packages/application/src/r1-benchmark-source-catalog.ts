import type { CapabilityDimension } from '@cultivation/domain';

/** Reference links only. Benchmark values are always entered by the user. */
export interface BenchmarkSourceCatalogEntry {
  id: string;
  name: string;
  url: string;
  dimensions: readonly CapabilityDimension[];
  description: string;
}

/** First-party benchmark and leaderboard entry points; this catalog stores no scores. */
export const BENCHMARK_SOURCE_CATALOG: readonly BenchmarkSourceCatalogEntry[] = [
  {
    id: 'artificial-analysis-intelligence',
    name: 'Artificial Analysis LLM Leaderboard',
    url: 'https://artificialanalysis.ai/evaluations/artificial-analysis-intelligence-index',
    dimensions: ['GENERAL_REASONING'],
    description: 'Artificial Analysis model comparison and intelligence benchmark entry point.',
  },
  {
    id: 'artificial-analysis-coding-agents',
    name: 'Artificial Analysis Coding Agent Benchmarks',
    url: 'https://artificialanalysis.ai/agents/coding-agents/',
    dimensions: ['CODING', 'AGENTIC_EXECUTION', 'TOOL_USE'],
    description: 'Artificial Analysis coding-agent benchmark suite and methodology.',
  },
  {
    id: 'artificial-analysis-lcr',
    name: 'Artificial Analysis Long Context Reasoning Benchmark',
    url: 'https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning',
    dimensions: ['LONG_CONTEXT_REASONING'],
    description: 'Artificial Analysis long-document reasoning benchmark and results.',
  },
  {
    id: 'mmmu',
    name: 'MMMU Multimodal Understanding Benchmark',
    url: 'https://mmmu-benchmark.github.io/',
    dimensions: ['VISUAL_UNDERSTANDING'],
    description: 'Benchmark authors’ multimodal understanding benchmark and leaderboard.',
  },
  {
    id: 'artificial-analysis-image',
    name: 'Artificial Analysis Image Model Comparisons',
    url: 'https://artificialanalysis.ai/image/models',
    dimensions: ['IMAGE_GENERATION', 'IMAGE_EDITING'],
    description: 'Artificial Analysis image generation and image editing comparisons.',
  },
  {
    id: 'artificial-analysis-video',
    name: 'Artificial Analysis Video Model Comparisons',
    url: 'https://artificialanalysis.ai/video/models',
    dimensions: ['VIDEO_GENERATION', 'VIDEO_EDITING'],
    description: 'Artificial Analysis text-to-video, image-to-video, and editing comparisons.',
  },
  {
    id: 'artificial-analysis-speech-understanding',
    name: 'Artificial Analysis Speech to Text Leaderboard',
    url: 'https://artificialanalysis.ai/speech-to-text/streaming',
    dimensions: ['SPEECH_UNDERSTANDING'],
    description: 'Artificial Analysis speech recognition model and provider comparisons.',
  },
  {
    id: 'artificial-analysis-speech-generation',
    name: 'Artificial Analysis Text to Speech Leaderboard',
    url: 'https://artificialanalysis.ai/text-to-speech/leaderboard',
    dimensions: ['SPEECH_GENERATION'],
    description: 'Artificial Analysis speech generation model comparisons.',
  },
  {
    id: 'artificial-analysis-speech-to-speech',
    name: 'Artificial Analysis Speech to Speech Leaderboard',
    url: 'https://artificialanalysis.ai/speech-to-speech',
    dimensions: ['SPEECH_TO_SPEECH'],
    description: 'Artificial Analysis speech-to-speech model and provider comparisons.',
  },
  {
    id: 'artificial-analysis-music',
    name: 'Artificial Analysis Instrumental Music Leaderboard',
    url: 'https://artificialanalysis.ai/music/leaderboard/instrumental',
    dimensions: ['MUSIC_GENERATION'],
    description: 'Artificial Analysis instrumental music generation preference leaderboard.',
  },
];
