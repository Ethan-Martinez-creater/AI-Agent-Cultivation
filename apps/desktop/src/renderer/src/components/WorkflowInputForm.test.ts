import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { validateWorkflowInputs, type WorkflowObjectSchema } from '@cultivation/domain';
import {
  createInitialWorkflowInputs,
  normalizeWorkflowInputDraft,
  WorkflowInputForm,
} from './WorkflowInputForm.js';

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
});
