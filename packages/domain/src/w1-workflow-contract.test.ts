import { describe, expect, it } from 'vitest';
import {
  validateWorkflowInputs,
  validateWorkflowInputSchema,
  workflowInputsForStep,
} from './w1-workflow-contract.js';
import type { WorkflowObjectSchema } from './w1-workflow-contract.js';
import type { WorkflowVersion } from './w1-workflow.js';
const schema: WorkflowObjectSchema = {
  type: 'object',
  required: ['topic', 'mode', 'limit'],
  properties: {
    topic: { type: 'string', minLength: 1, maxLength: 80 },
    mode: { type: 'enum', values: ['brief', 'full'] },
    limit: { type: 'number', minimum: 1, maximum: 10, integer: true },
    approved: { type: 'boolean' },
    tags: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: { type: 'string', minLength: 1, maxLength: 20 },
    },
    options: {
      type: 'object',
      required: ['enabled'],
      properties: { enabled: { type: 'boolean' } },
    },
    date: { type: 'date', minDate: '2026-01-01', maxDate: '2026-12-31' },
    period: { type: 'dateRange', minDate: '2026-01-01', maxDate: '2026-12-31' },
    reference: { type: 'artifactRef', allowedKinds: ['FILE', 'EXTERNAL_REFERENCE'] },
  },
};
const valid = { topic: 'A bounded topic', mode: 'brief', limit: 3 };
describe('W1 frozen I/O contract', () => {
  it('expresses all foundation field types without file or state authority', () => {
    const value = {
      ...valid,
      approved: false,
      tags: ['a', 'b'],
      options: { enabled: true },
      date: '2026-10-01',
      period: { start: '2026-09-01', end: '2026-10-01' },
      reference: { id: 'opaque-id', kind: 'FILE', name: 'report.txt', contentHash: 'a'.repeat(64) },
    };
    expect(validateWorkflowInputs(schema, value)).toEqual(value);
    expect(validateWorkflowInputs(schema, valid)).toEqual(valid);
  });
  it.each([
    [{ mode: 'brief', limit: 1 }, 'missing'],
    [{ ...valid, extra: 'unexpected' }, 'unknown'],
    [{ ...valid, mode: 'invalid' }, 'enum'],
    [{ ...valid, limit: 0 }, 'minimum'],
    [{ ...valid, limit: 11 }, 'maximum'],
    [{ ...valid, limit: 2.5 }, 'integer'],
    [{ ...valid, tags: [] }, 'array minimum'],
    [{ ...valid, tags: ['a', 'b', 'c'] }, 'array maximum'],
    [{ ...valid, options: { enabled: true, permission: 'ALLOW' } }, 'nested unknown'],
    [{ ...valid, date: '2026-02-30' }, 'calendar'],
    [{ ...valid, date: '2027-01-01' }, 'date bounds'],
    [{ ...valid, period: { start: '2026-10-02', end: '2026-10-01' } }, 'reversed period'],
    [
      { ...valid, reference: { id: 'opaque', kind: 'FILE', path: 'C:\\private' } },
      'path authority',
    ],
    [{ ...valid, reference: { id: 'opaque', kind: 'DIRECTORY' } }, 'reference kind'],
  ])('rejects invalid input (%s, %s)', (value, reason) => {
    expect(reason.length).toBeGreaterThan(0);
    expect(() => validateWorkflowInputs(schema, value)).toThrow();
  });
  it('enforces bounds without defaults or coercion', () => {
    expect(() =>
      validateWorkflowInputSchema({
        type: 'object',
        required: [],
        properties: {
          huge: { type: 'array', items: { type: 'boolean' }, minItems: 0, maxItems: 10000 },
        },
      }),
    ).toThrow();
    expect(() => validateWorkflowInputs(schema, { ...valid, limit: '3' })).toThrow();
    expect(() => validateWorkflowInputs(schema, { ...valid, approved: null })).toThrow();
    const copy = validateWorkflowInputs(schema, valid);
    copy.topic = 'changed';
    expect(valid.topic).toBe('A bounded topic');
    expect(Object.hasOwn(validateWorkflowInputs(schema, valid), 'approved')).toBe(false);
  });
  it('projects only declared fields with a separate model data budget', () => {
    const version = {
      steps: [{ id: 'a', workflowInputKeys: ['topic'] }, { id: 'b' }],
    } as unknown as WorkflowVersion;
    expect(workflowInputsForStep(version, { ...valid, privateField: 'hidden' }, 'a')).toEqual({
      topic: valid.topic,
    });
    expect(workflowInputsForStep(version, valid, 'b')).toEqual({});
    expect(() => workflowInputsForStep(version, { topic: 'a'.repeat(9000) }, 'a')).toThrow();
  });
});
