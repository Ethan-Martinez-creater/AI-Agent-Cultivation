import { describe, expect, it } from 'vitest';
import { WorkflowToolGuard } from './w22-workspace-mutations.js';

function guard(stepId = 'R08', state = 'PREPARED') {
  const step = {
    id: 'attempt-new',
    workflowRunId: 'workflow',
    stepId,
    missionId: 'mission',
    missionRunId: 'run',
    state: 'RUNNING',
  };
  return new WorkflowToolGuard(
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
}
const context = { missionId: 'mission', runId: 'run', teammateId: 'actor' };
const descriptor = {
  source: 'BUILTIN',
  capability: 'FILE_WRITE',
  sideEffect: 'LOCAL_WRITE',
} as never;

describe('research experiment write scope preserves previous attempts', () => {
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
    ).resolves.toEqual({ kind: 'NOOP' });
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
