import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkflowStepDefinition, WorkflowVersion } from '@cultivation/domain';
import {
  completionOriginOf,
  importableStepPrefix,
  workflowImportUnsupportedReason,
  WorkflowImport,
} from './WorkflowImport.js';

function step(
  id: string,
  type: WorkflowStepDefinition['type'] = 'TASK',
  effectType: WorkflowStepDefinition['effectType'] = 'NONE',
  outputKinds: WorkflowStepDefinition['outputs'][number]['kind'][] = [],
): WorkflowStepDefinition {
  return {
    id,
    type,
    effectType,
    title: `步骤 ${id}`,
    objective: '边界测试步骤',
    routing: {} as WorkflowStepDefinition['routing'],
    inputs: [],
    outputs: outputKinds.map((kind, index) => ({
      key: `output_${index}`,
      kind,
      required: false,
      contractId: 'test.contract',
      contractVersion: '1',
      maxSizeBytes: 4096,
      description: '测试输出',
      validator: { type: 'TEXT', minLength: 1, requiredSections: [] },
    })),
    maxAttempts: 1,
    exitCondition: 'VALID_OUTPUTS',
  };
}

function alwaysEdge(fromStepId: string, toStepId: string | null): WorkflowVersion['edges'][number] {
  return {
    id: `${fromStepId}-${toStepId ?? 'end'}`,
    fromStepId,
    toStepId,
    branch: 'NEXT',
    condition: { type: 'ALWAYS' },
  };
}

function version(
  id: string,
  steps: WorkflowStepDefinition[],
  source: WorkflowVersion['definition']['source'] = 'USER',
  options: {
    entryStepId?: string;
    edges?: WorkflowVersion['edges'];
    version?: number;
  } = {},
): WorkflowVersion {
  const sequence = steps.map((item, index) => alwaysEdge(item.id, steps[index + 1]?.id ?? null));
  return {
    definition: { id, name: '测试版本', description: '', category: '', source },
    version: options.version ?? 1,
    entryStepId: options.entryStepId ?? steps[0]?.id ?? '',
    steps,
    edges: options.edges ?? sequence,
    referenceBasis: [],
    createdAt: '2026-10-09T00:00:00.000Z',
  };
}

describe('workflow import UI boundary', () => {
  it('walks the frozen single ALWAYS path instead of trusting array order', () => {
    const item = version(
      'user.workflow',
      [step('T02'), step('R01', 'REVIEW'), step('T01')],
      'USER',
      {
        entryStepId: 'T01',
        edges: [alwaysEdge('T01', 'T02'), alwaysEdge('T02', 'R01'), alwaysEdge('R01', null)],
      },
    );

    expect(importableStepPrefix(item).map((candidate) => candidate.id)).toEqual(['T01', 'T02']);
  });

  it('keeps a real step after the imported prefix', () => {
    const item = version('user.workflow', [step('T01'), step('T02')]);

    expect(importableStepPrefix(item).map((candidate) => candidate.id)).toEqual(['T01']);
    expect(importableStepPrefix(version('one-step', [step('T01')]))).toEqual([]);
  });

  it('rejects branches, revisions, effects, and FILE or DIRECTORY outputs', () => {
    const branched = version('branched', [step('T01'), step('T02')], 'USER', {
      edges: [
        alwaysEdge('T01', 'T02'),
        {
          ...alwaysEdge('T01', null),
          id: 'conditional',
          branch: 'OTHER',
          condition: {
            type: 'JSON_FIELD_EQUALS',
            inputKey: 'decision',
            field: 'mode',
            equals: 'yes',
          },
        },
        alwaysEdge('T02', null),
      ],
    });
    const revision = version('revision', [step('T01'), step('T02')], 'USER', {
      edges: [
        { ...alwaysEdge('T01', 'T02'), revision: { groupId: 'review', maxTraversals: 1 } },
        alwaysEdge('T02', null),
      ],
    });
    const fileOutput = version('file-output', [step('T01', 'TASK', 'NONE', ['FILE']), step('T02')]);
    const directoryOutput = version('directory-output', [
      step('T01', 'TASK', 'NONE', ['DIRECTORY']),
      step('T02'),
    ]);
    const effect = version('effect', [step('T01', 'TASK', 'FILE_OUTPUT'), step('T02')]);
    const reviewPass = version('review-pass', [
      { ...step('T01'), exitCondition: 'REVIEW_PASS' },
      step('T02'),
    ]);
    const selfCycle = version('cycle', [step('T01')], 'USER', {
      edges: [alwaysEdge('T01', 'T01')],
    });

    expect(importableStepPrefix(branched)).toEqual([]);
    expect(importableStepPrefix(revision)).toEqual([]);
    expect(importableStepPrefix(fileOutput)).toEqual([]);
    expect(importableStepPrefix(directoryOutput)).toEqual([]);
    expect(importableStepPrefix(effect)).toEqual([]);
    expect(importableStepPrefix(reviewPass)).toEqual([]);
    expect(importableStepPrefix(selfCycle)).toEqual([]);
  });

  it('allows only official research v1 R01 among builtins', () => {
    const research = version(
      'official.research',
      [step('R01'), step('R02'), step('R03', 'REVIEW')],
      'BUILTIN',
    );
    const otherOfficial = version(
      'official.software-feature',
      [step('T01'), step('T02')],
      'BUILTIN',
    );
    const laterResearch = version('official.research', [step('R01'), step('R02')], 'BUILTIN', {
      version: 2,
    });

    expect(importableStepPrefix(research).map((candidate) => candidate.id)).toEqual(['R01']);
    expect(importableStepPrefix(otherOfficial)).toEqual([]);
    expect(workflowImportUnsupportedReason(otherOfficial)).toContain('官方版本暂不支持导入');
    expect(importableStepPrefix(laterResearch)).toEqual([]);
  });

  it('defaults legacy rows to executed and recognizes only IMPORTED_CONFIRMED', () => {
    expect(completionOriginOf({})).toBe('EXECUTED');
    expect(completionOriginOf({ completionOrigin: 'IMPORTED_CONFIRMED' })).toBe(
      'IMPORTED_CONFIRMED',
    );
    expect(completionOriginOf({ source: 'IMPORTED_CONFIRMED' })).toBe('IMPORTED_CONFIRMED');
    expect(completionOriginOf({ completionOrigin: 'IMPORTED' })).toBe('EXECUTED');
  });

  it('uses schema inputs and exposes no Renderer file path field', () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkflowImport, {
        version: version('user.workflow', [{ ...step('T01'), title: '整理研究提纲' }, step('T02')]),
        open: true,
        onClose: () => {},
        onConfirmed: () => {},
      }),
    );

    expect(html).toContain('准备导入提案');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('文件路径');
    expect(html).not.toContain('绝对路径');
    expect(html).not.toContain('T01');
    expect(html).not.toContain('TASK/NONE');
  });
});
