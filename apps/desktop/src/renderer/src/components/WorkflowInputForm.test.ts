import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { validateWorkflowInputs, type WorkflowObjectSchema } from '@cultivation/domain';
import {
  createInitialWorkflowInputs,
  normalizeWorkflowInputDraft,
  WorkflowInputForm,
} from './WorkflowInputForm.js';
import {
  RESEARCH_WORKFLOW_INPUT_PRESENTATION,
  workflowInputPresentationFor,
  workflowPhaseLabelFor,
} from './workflow-input-presentations.js';

const schema: WorkflowObjectSchema = {
  type: 'object',
  title: '任务参数',
  description: '按冻结版本填写。',
  required: ['topic', 'enabled'],
  properties: {
    topic: { type: 'string', title: '主题', minLength: 2, maxLength: 80 },
    enabled: { type: 'boolean', title: '启用审核' },
    targetCount: { type: 'number', title: '目标数量', minimum: 1, maximum: 20, integer: true },
    priority: { type: 'enum', title: '优先级', values: ['LOW', 'HIGH'] },
    privateNote: { type: 'string', title: '仅保存备注', minLength: 0, maxLength: 120 },
    dueDate: { type: 'date', title: '截止日期', minDate: '2026-01-01' },
    period: { type: 'dateRange', title: '计划周期' },
    topics: {
      type: 'array',
      title: '子主题',
      items: { type: 'string', minLength: 1, maxLength: 80 },
      minItems: 0,
      maxItems: 3,
    },
    source: { type: 'artifactRef', title: '参考交付', allowedKinds: ['TEXT', 'JSON'] },
    options: {
      type: 'object',
      title: '选项',
      properties: { includeSummary: { type: 'boolean', title: '包含摘要' } },
      required: [],
    },
  },
};

const newsSchema: WorkflowObjectSchema = {
  type: 'object',
  required: [
    'topicScope',
    'timeRange',
    'language',
    'targetPlatform',
    'targetDurationSeconds',
    'targetStoryCount',
    'narrationMode',
  ],
  properties: {
    topicScope: { type: 'string', title: '主题范围', minLength: 1, maxLength: 300 },
    timeRange: {
      type: 'object',
      title: '时间范围',
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', minLength: 1, maxLength: 40 },
        to: { type: 'string', minLength: 1, maxLength: 40 },
      },
    },
    language: { type: 'string', title: '语言', minLength: 1, maxLength: 64 },
    targetPlatform: {
      type: 'enum',
      values: ['YOUTUBE_LONG', 'YOUTUBE_SHORTS', 'BILIBILI', 'GENERIC'],
    },
    targetDurationSeconds: {
      type: 'number',
      minimum: 15,
      maximum: 3600,
      integer: true,
    },
    targetStoryCount: {
      type: 'object',
      required: ['min', 'max'],
      properties: {
        min: { type: 'number', minimum: 1, maximum: 5, integer: true },
        max: { type: 'number', minimum: 1, maximum: 5, integer: true },
      },
    },
    narrationMode: { type: 'enum', values: ['AUTO', 'MODEL_OR_TOOL', 'HUMAN'] },
  },
};

const researchSchema: WorkflowObjectSchema = {
  type: 'object',
  required: ['researchQuestion', 'field', 'experimentMode'],
  properties: {
    researchQuestion: { type: 'string', minLength: 10, maxLength: 3000 },
    field: { type: 'string', minLength: 2, maxLength: 200 },
    scope: { type: 'string', minLength: 0, maxLength: 2000 },
    literatureTimeRange: {
      type: 'object',
      required: [],
      properties: {
        from: { type: 'date' },
        to: { type: 'date' },
      },
    },
    existingSources: {
      type: 'array',
      minItems: 0,
      maxItems: 12,
      items: { type: 'artifactRef', allowedKinds: ['TEXT', 'JSON', 'FILE', 'EXTERNAL_REFERENCE'] },
    },
    existingData: {
      type: 'array',
      minItems: 0,
      maxItems: 12,
      items: { type: 'artifactRef', allowedKinds: ['FILE', 'JSON', 'DIRECTORY'] },
    },
    existingCode: {
      type: 'array',
      minItems: 0,
      maxItems: 12,
      items: { type: 'artifactRef', allowedKinds: ['TEXT', 'FILE', 'DIRECTORY'] },
    },
    experimentMode: { type: 'enum', values: ['COMPUTATIONAL', 'HUMAN_OR_EXTERNAL', 'MIXED'] },
    maxExperimentCycles: { type: 'number', minimum: 1, maximum: 2, integer: true },
  },
};

describe('WorkflowInputForm', () => {
  it('builds a valid typed snapshot from schema-shaped draft values', () => {
    const initial = createInitialWorkflowInputs(schema);
    expect(initial).toEqual({ topic: '', enabled: false });
    const inputs = normalizeWorkflowInputDraft(schema, {
      topic: 'Quarterly report',
      enabled: true,
      targetCount: '4',
      priority: 'HIGH',
      privateNote: '',
      dueDate: '2026-06-15',
      period: { start: '2026-06-01', end: '2026-06-30' },
      topics: ['Revenue', 'Hiring'],
      source: { id: 'artifact-opaque-id', kind: 'TEXT', name: 'Source notes' },
      options: { includeSummary: false },
    });

    expect(inputs).toEqual({
      topic: 'Quarterly report',
      enabled: true,
      targetCount: 4,
      priority: 'HIGH',
      privateNote: '',
      dueDate: '2026-06-15',
      period: { start: '2026-06-01', end: '2026-06-30' },
      topics: ['Revenue', 'Hiring'],
      source: { id: 'artifact-opaque-id', kind: 'TEXT', name: 'Source notes' },
      options: { includeSummary: false },
    });
    expect(() => validateWorkflowInputs(schema, inputs)).not.toThrow();
    expect(
      normalizeWorkflowInputDraft(schema, { topic: 'Quarterly report', enabled: false }),
    ).not.toHaveProperty('privateNote');
  });

  it('renders external labels and bounded controls without placeholders or file access', () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkflowInputForm, { schema, onSubmit: () => undefined }),
    );

    expect(markup).toContain('主题');
    expect(markup).toContain('启用审核');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('type="date"');
    expect(markup).toContain('id="workflow-input-period-start"');
    expect(markup).toContain('id="workflow-input-period-end"');
    expect(markup).toContain('添加一项');
    expect(markup).toContain('引用 ID');
    expect(markup).not.toContain('placeholder=');
    expect(markup).not.toContain('type="file"');
  });

  it('lets the frozen schema validator report unknown and malformed values', () => {
    expect(() =>
      validateWorkflowInputs(schema, { topic: 'ok', enabled: false, extra: 'not declared' }),
    ).toThrow('包含未声明字段');
    expect(() =>
      validateWorkflowInputs(schema, { topic: 'ok', enabled: false, targetCount: 21 }),
    ).toThrow('不符合冻结版本的约定');
  });

  it('presents official news inputs in Chinese while preserving frozen values', () => {
    const presentation = workflowInputPresentationFor('official.ai-news-video');
    expect(presentation).toBeDefined();
    const markup = renderToStaticMarkup(
      React.createElement(WorkflowInputForm, {
        schema: newsSchema,
        presentation,
        onSubmit: () => undefined,
      }),
    );

    for (const label of [
      '新闻时间范围',
      '开始时间',
      '结束时间',
      '发布平台',
      '目标时长（秒）',
      '新闻条数范围',
      '最少条数',
      '最多条数',
      '配音方式',
      'YouTube Shorts 短视频',
      '由本尊完成',
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('value="YOUTUBE_SHORTS">YouTube Shorts 短视频</option>');
    expect(markup).toContain('value="MODEL_OR_TOOL">使用可用配音工具</option>');
    expect(markup).not.toContain('>YOUTUBE_SHORTS</option>');
    expect(markup).not.toContain('>MODEL_OR_TOOL</option>');

    const inputs = normalizeWorkflowInputDraft(newsSchema, {
      topicScope: '芯片新闻',
      timeRange: { from: '2026-09-25T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
      language: 'zh-CN',
      targetPlatform: 'YOUTUBE_SHORTS',
      targetDurationSeconds: '60',
      targetStoryCount: { min: '1', max: '1' },
      narrationMode: 'MODEL_OR_TOOL',
    });
    expect(inputs.targetPlatform).toBe('YOUTUBE_SHORTS');
    expect(inputs.narrationMode).toBe('MODEL_OR_TOOL');
    expect(() => validateWorkflowInputs(newsSchema, inputs)).not.toThrow();
  });

  it('presents official research inputs and modes in Chinese without changing the frozen values', () => {
    expect(workflowInputPresentationFor('official.research')).toEqual(
      RESEARCH_WORKFLOW_INPUT_PRESENTATION,
    );
    const markup = renderToStaticMarkup(
      React.createElement(WorkflowInputForm, {
        schema: researchSchema,
        presentation: workflowInputPresentationFor('official.research'),
        onSubmit: () => undefined,
      }),
    );

    for (const label of [
      '研究问题',
      '研究领域',
      '研究范围',
      '文献时间范围',
      '起始日期',
      '结束日期',
      '已有来源',
      '已有数据',
      '已有代码',
      '实验方式',
      '最大实验循环次数',
      '可计算实验',
      '人工或外部实验',
      '混合实验',
    ]) {
      expect(markup).toContain(label);
    }
    const literatureRangeMarkup = markup.match(
      /<fieldset class="[^"]*workflow-input-research-date-range[^"]*">[\s\S]*?<\/fieldset>/,
    )?.[0];
    expect(literatureRangeMarkup).toBeDefined();
    expect([...literatureRangeMarkup!.matchAll(/type="date"/g)]).toHaveLength(2);
    expect(literatureRangeMarkup).not.toContain('workflow-input-fields');
    expect(literatureRangeMarkup).not.toContain('workflow-input-clear');

    expect(markup).toContain('value="COMPUTATIONAL">可计算实验</option>');
    expect(markup).toContain('value="HUMAN_OR_EXTERNAL">人工或外部实验</option>');
    expect(markup).toContain('value="MIXED">混合实验</option>');
    expect(markup).not.toContain('>COMPUTATIONAL</option>');
    expect(markup).not.toContain('>HUMAN_OR_EXTERNAL</option>');
    expect(markup).not.toContain('>MIXED</option>');
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain('placeholder=');

    const inputs = normalizeWorkflowInputDraft(researchSchema, {
      researchQuestion: '比较两种缓存策略对服务尾延迟的影响',
      field: '计算机系统',
      scope: '单机服务负载',
      literatureTimeRange: { from: '2022-01-01', to: '2026-01-01' },
      existingSources: [
        { id: 'artifact-source-1', kind: 'EXTERNAL_REFERENCE', name: '用户提供来源' },
      ],
      existingData: [{ id: 'artifact-data-1', kind: 'FILE', name: '测量数据' }],
      existingCode: [{ id: 'artifact-code-1', kind: 'DIRECTORY', name: '实验代码' }],
      experimentMode: 'MIXED',
      maxExperimentCycles: '2',
    });
    expect(inputs.experimentMode).toBe('MIXED');
    expect(inputs.maxExperimentCycles).toBe(2);
    expect(inputs.literatureTimeRange).toEqual({ from: '2022-01-01', to: '2026-01-01' });
    expect(inputs.existingSources).toEqual([
      { id: 'artifact-source-1', kind: 'EXTERNAL_REFERENCE', name: '用户提供来源' },
    ]);
    expect(() => validateWorkflowInputs(researchSchema, inputs)).not.toThrow();
  });

  it('uses the six declared Chinese research phases only for the official research workflow', () => {
    expect(
      ['exploration', 'hypothesis', 'experiment', 'analysis', 'writing', 'review'].map((phase) =>
        workflowPhaseLabelFor('official.research', phase),
      ),
    ).toEqual(['探索', '假设', '实验', '分析', '写作', '审查']);
    expect(workflowPhaseLabelFor('user.workflow', 'exploration')).toBeUndefined();
  });

  it('does not apply the official news presentation to other definitions', () => {
    expect(workflowInputPresentationFor('user.workflow')).toBeUndefined();
  });
});
