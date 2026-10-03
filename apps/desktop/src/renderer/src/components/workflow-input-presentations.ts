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
        allowedToolScope: '确认允许使用的工具 ID',
        contextArtifacts: '参考资料',
      },
    };
  return definitionId === 'official.ai-news-video' ? AI_NEWS_VIDEO_INPUT_PRESENTATION : undefined;
}
