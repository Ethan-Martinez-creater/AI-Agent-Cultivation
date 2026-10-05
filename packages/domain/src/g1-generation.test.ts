import { describe, expect, it } from 'vitest';
import { transitionGenerationJob } from './g1-generation.js';
describe('G1 GenerationJob state machine', () => {
  it('submission never completes directly and uncertainty has no automatic resubmit', () => {
    expect(transitionGenerationJob('PENDING', 'SUBMITTING')).toBe('SUBMITTING');
    expect(transitionGenerationJob('SUBMITTING', 'QUEUED')).toBe('QUEUED');
    expect(transitionGenerationJob('QUEUED', 'RUNNING')).toBe('RUNNING');
    expect(transitionGenerationJob('RUNNING', 'COMPLETED')).toBe('COMPLETED');
    for (const [from, to] of [
      ['PENDING', 'COMPLETED'],
      ['SUBMITTING', 'COMPLETED'],
      ['UNKNOWN', 'PENDING'],
      ['UNKNOWN', 'SUBMITTING'],
      ['COMPLETED', 'RUNNING'],
      ['FAILED', 'QUEUED'],
    ] as const)
      expect(() => transitionGenerationJob(from, to)).toThrow(/Invalid/);
  });
});
