import type { WorkflowInputPresentation } from './WorkflowInputForm.js';

/** Renderer-only labels for the frozen AP-007 AI News Video input contract. */
export const AI_NEWS_VIDEO_INPUT_PRESENTATION: WorkflowInputPresentation = {
  fieldLabels: {
    topicScope: '主题范围',
    timeRange: '新闻时间范围',
    'timeRange.from': '开始时间',
    'timeRange.to': '结束时间',
    language: '输出语言',
    targetPlatform: '发布平台',
    targetDurationSeconds: '目标时长（秒）',
    targetStoryCount: '新闻条数范围',
    'targetStoryCount.min': '最少条数',
    'targetStoryCount.max': '最多条数',
    editorialStyle: '编辑风格',
    sourcePreferences: '优先来源',
    excludedSources: '排除来源',
    narrationMode: '配音方式',
    existingAssets: '已有素材',
  },
  enumOptionLabels: {
    targetPlatform: {
      YOUTUBE_LONG: 'YouTube 长视频',
      YOUTUBE_SHORTS: 'YouTube Shorts 短视频',
      BILIBILI: '哔哩哔哩',
      GENERIC: '通用视频',
    },
    narrationMode: {
      AUTO: '自动选择',
      MODEL_OR_TOOL: '使用可用配音工具',
      HUMAN: '由本尊完成',
    },
  },
};

/** Renderer-only labels for the frozen AP-007 Research Workflow inputs. */
export const RESEARCH_WORKFLOW_INPUT_PRESENTATION: WorkflowInputPresentation = {
  fieldLabels: {
    researchQuestion: '研究问题',
    field: '研究领域',
    scope: '研究范围',
    literatureTimeRange: '文献时间范围',
    'literatureTimeRange.from': '起始日期',
    'literatureTimeRange.to': '结束日期',
    existingSources: '已有来源',
    existingData: '已有数据',
    existingCode: '已有代码',
    experimentMode: '实验方式',
    maxExperimentCycles: '最大实验循环次数',
  },
  enumOptionLabels: {
    experimentMode: {
      COMPUTATIONAL: '可计算实验',
      HUMAN_OR_EXTERNAL: '人工或外部实验',
      MIXED: '混合实验',
    },
  },
};

export const RESEARCH_WORKFLOW_PHASE_LABELS: Readonly<Record<string, string>> = {
  exploration: '探索',
  hypothesis: '假设',
  experiment: '实验',
  analysis: '分析',
  writing: '写作',
  review: '审查',
};

export function workflowPhaseLabelFor(
  definitionId: string | undefined,
  phase: string,
): string | undefined {
  return definitionId === 'official.research' ? RESEARCH_WORKFLOW_PHASE_LABELS[phase] : undefined;
}

export function workflowInputPresentationFor(
  definitionId: string,
): WorkflowInputPresentation | undefined {
  if (definitionId === 'official.software-feature')
    return {
      fieldLabels: {
        objective: '开发目标',
        workspaceRoot: '项目 Workspace',
        constraints: '约束',
        targetArea: '允许修改的相对路径 / 模块',
        userAcceptanceNotes: '人工验收要求',
        allowedToolScope: '允许使用的工具',
        contextArtifacts: '参考资料',
      },
    };
  if (definitionId === 'official.research') return RESEARCH_WORKFLOW_INPUT_PRESENTATION;
  return definitionId === 'official.ai-news-video' ? AI_NEWS_VIDEO_INPUT_PRESENTATION : undefined;
}
