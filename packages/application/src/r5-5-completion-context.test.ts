import { describe, expect, it } from 'vitest';
import { completionPublicResult, completionToolSummary } from './r5-5-completion-context.js';
import type { MissionEvent } from '@cultivation/domain';

describe('R5.5 trusted completion context', () => {
  it.each(['NEEDS_INPUT', 'NEEDS_CAPABILITY', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'])(
    'preserves %s control plane without sending its private content',
    (kind) => {
      const outcome =
        kind === 'NEEDS_INPUT'
          ? { kind, requirements: [], reason: 'PRIVATE_REASON' }
          : kind === 'NEEDS_CAPABILITY'
            ? {
                kind,
                capability: 'IMAGE_GENERATION',
                requestedInputs: [],
                reason: 'PRIVATE_REASON',
              }
            : { kind, errorCode: 'FAILED', reason: 'PRIVATE_REASON' };
      expect(completionPublicResult(JSON.stringify(outcome), true)).toBe(kind);
    },
  );
  it('only exposes RESULT publicResult and rejects malformed structured control plane', () => {
    expect(
      completionPublicResult(
        JSON.stringify({ kind: 'RESULT', publicResult: '公开结果', artifactRefs: [] }),
        true,
      ),
    ).toBe('公开结果');
    expect(
      completionPublicResult(
        JSON.stringify({
          kind: 'RESULT',
          publicResult: '公开结果',
          artifactRefs: [],
          privateBody: 'PRIVATE',
        }),
        true,
      ),
    ).toBeNull();
  });
  it('projects only run/actor-owned tool metadata and never resources/output/workflow evidence', () => {
    const event = {
      runId: 'r',
      actorId: 'a',
      eventType: 'tool.result',
      payloadJson: {
        toolId: 'file.readText',
        success: false,
        code: 'DENIED',
        resource: 'PRIVATE_PATH',
        workflowEvidence: { body: 'PRIVATE' },
        content: 'TOOL_OUTPUT',
      },
    } as unknown as MissionEvent;
    const summary = completionToolSummary(
      [event, { ...event, actorId: 'b' }, { ...event, runId: 'other' }],
      'r',
      'a',
    );
    expect(summary.toolCallCount).toBe(1);
    expect(summary.usedToolIds).toEqual(['file.readText']);
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|TOOL_OUTPUT/);
  });
});
