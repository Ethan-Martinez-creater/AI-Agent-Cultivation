import { describe, expect, it } from 'vitest';
import { WorkflowToolGuard } from './w22-workspace-mutations.js';

function guard(stepId = 'R08', state = 'PREPARED', attach = true) {
  const step = {
    id: 'attempt-new',
    workflowRunId: 'workflow',
    stepId,
    missionId: 'mission',
    missionRunId: 'run',
    state: 'RUNNING',
  };
  const value = new WorkflowToolGuard(
    {
      findStepByMissionId: () => step,
      bindMissionRun: () => step,
      detail: () => ({
        run: { id: 'workflow' },
        version: { definition: { source: 'BUILTIN' }, validationPolicy: 'research-integrity-v1' },
        steps: [step],
      }),
    } as never,
    { getOperation: () => ({ state, effectType: 'FILE_OUTPUT' }) } as never,
    () => 'workspace',
  );
  if (attach)
    value.attachResearchInputCheck(
      () => {},
      () => {},
    );
  return value;
}
const context = { missionId: 'mission', runId: 'run', teammateId: 'actor' };
const descriptor = {
  source: 'BUILTIN',
  capability: 'FILE_WRITE',
  sideEffect: 'LOCAL_WRITE',
} as never;

describe('research experiment write scope preserves previous attempts', () => {
  it('fails closed before executing if Main input validation/uncertainty hooks are absent', async () => {
    await expect(
      guard('R08', 'PREPARED', false).before(
        { id: 'call', toolId: 'file.writeText', input: {} },
        context,
        descriptor,
        { path: 'workflows/workflow/attempt-new/research/raw-result.json' },
        'resource',
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INTEGRITY_ERROR' });
  });
  it('checks frozen inputs before/after MCP execution and preserves uncertain effects', async () => {
    const value = guard();
    const observed: unknown[] = [];
    const uncertain: string[] = [];
    let changed = false;
    const ref = { id: 'input-dataset', kind: 'FILE', contentHash: 'a'.repeat(64) };
    value.attachResearchInputCheck(
      (_detail, consumed) => {
        observed.push(consumed);
        if (
          changed ||
          (consumed !== undefined && JSON.stringify(consumed) !== JSON.stringify([ref]))
        )
          throw new Error('input provenance mismatch');
      },
      (_detail, stepId) => uncertain.push(stepId),
    );
    const mcp = {
      source: 'MCP',
      capability: 'MCP_TOOL_EXECUTE',
      sideEffect: 'PROCESS_EXECUTION',
      workflowPurposes: ['RESEARCH'],
    } as never;
    const call = { id: 'call', toolId: 'mcp:experiment', input: {} };
    const token = await value.before(call, context, mcp, {}, 'resource');
    expect(observed).toEqual([undefined]);
    const content = (inputArtifacts: unknown) =>
      JSON.stringify({
        structuredContent: {
          workflowEvidence: {
            artifactFiles: [{ path: 'research/raw-result.json', contentHash: 'b'.repeat(64) }],
            experiment: {
              planArtifactId: 'plan',
              status: 'SUCCEEDED',
              method: 'test',
              negativeResult: false,
              inputArtifacts,
            },
          },
        },
      });
    await expect(
      value.after(token, context, { ok: true, code: 'OK', content: content([ref]) }),
    ).resolves.toBeUndefined();
    for (const inputArtifacts of [
      undefined,
      [],
      [{ ...ref, id: 'another-run' }],
      [{ ...ref, contentHash: 'c'.repeat(64) }],
    ]) {
      await expect(
        value.after(token, context, { ok: true, code: 'OK', content: content(inputArtifacts) }),
      ).rejects.toThrow();
    }
    changed = true;
    await expect(value.before(call, context, mcp, {}, 'resource')).rejects.toThrow();
    await expect(
      value.after(token, context, { ok: true, code: 'OK', content: content([ref]) }),
    ).rejects.toThrow();
    expect(uncertain).toHaveLength(5);
  });
  it('permits only current attempt raw output and rejects previous attempt paths', async () => {
    const value = guard();
    const call = { id: 'call', toolId: 'file.writeText', input: {} };
    await expect(
      value.before(
        call,
        context,
        descriptor,
        { path: 'workflows/workflow/attempt-new/research/raw-result.json' },
        'resource',
      ),
    ).resolves.toMatchObject({ kind: 'NOOP', stepRunId: 'attempt-new' });
    await expect(
      value.before(
        call,
        context,
        descriptor,
        { path: 'workflows/workflow/attempt-old/research/raw-result.json' },
        'resource',
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_MUTATION_SCOPE_DENIED' });
  });
  it('cannot create unrelated directories or mutate from an analysis step', async () => {
    await expect(
      guard().before(
        { id: 'call', toolId: 'file.createDirectory', input: {} },
        context,
        descriptor,
        { path: 'other' },
        'resource',
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_MUTATION_SCOPE_DENIED' });
    await expect(
      guard('R09').before(
        { id: 'call', toolId: 'file.writeText', input: {} },
        context,
        descriptor,
        { path: 'workflows/workflow/attempt-new/research/raw-result.json' },
        'resource',
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_MUTATION_SCOPE_DENIED' });
  });
  it('never repeats a mutation with an APPLIED receipt', async () => {
    await expect(
      guard('R08', 'APPLIED').before(
        { id: 'call', toolId: 'file.writeText', input: {} },
        context,
        descriptor,
        { path: 'workflows/workflow/attempt-new/research/raw-result.json' },
        'resource',
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_OPERATION_INVALID' });
  });
  it('analysis cannot rerun a side-effecting MCP experiment outside R08', async () => {
    await expect(
      guard('R09').before(
        { id: 'call', toolId: 'mcp:server:experiment', input: {} },
        context,
        { source: 'MCP', capability: 'MCP_TOOL_EXECUTE', sideEffect: 'PROCESS_EXECUTION' } as never,
        {},
        'resource',
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_TOOL_SCOPE_DENIED' });
  });
});
