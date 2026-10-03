import { describe, expect, it, vi } from 'vitest';
import type { WorkflowDetail, WorkflowStepRun } from '@cultivation/domain';
import { WorkflowMissionAdapter } from './w1-mission-adapter.js';
import { SOFTWARE_FEATURE_VERSION_1 } from '../../../../packages/application/src/builtin/software-feature/v1.js';

function fixture() {
  const author = {
    id: 'implementation',
    stepId: 'S05',
    missionId: 'author-mission',
    state: 'COMPLETED',
  };
  const fix = { id: 'fix', stepId: 'S10', missionId: 'fix-mission', state: 'COMPLETED' };
  const reviewer = {
    id: 'review',
    stepId: 'S08',
    missionId: null,
    state: 'READY',
  } as WorkflowStepRun;
  const detail = {
    version: SOFTWARE_FEATURE_VERSION_1,
    run: {
      inputSnapshot: {
        workspaceRoot: 'E:/workspace',
        targetArea: ['src'],
        allowedToolScope: ['file.writeText'],
      },
    },
    steps: [author, fix, reviewer],
    artifacts: [],
    bindings: [],
  } as unknown as WorkflowDetail;
  const store = {
    getMission: vi.fn((id: string) => ({
      coordinatorTeammateId: id === 'author-mission' ? 'author' : 'fixer',
    })),
    listMissionEvents: vi.fn(() => [
      { eventType: 'model.call_started', actorType: 'TEAMMATE', actorId: 'actual-participant' },
      { eventType: 'collaboration.denied', actorType: 'TEAMMATE', actorId: 'unexecuted-target' },
    ]),
  };
  const adapter = new WorkflowMissionAdapter(
    {} as never,
    store as never,
    {} as never,
    {} as never,
    {} as never,
    () => 'E:/workspace',
    undefined,
    () => [{ id: 'file.writeText' }] as never,
  );
  return { adapter, detail, reviewer, store };
}

describe('software trusted execution preparation', () => {
  it('keeps COMMAND + MANUAL verification on a model executor before its bounded manual handoff', async () => {
    const { adapter, detail, reviewer } = fixture();
    detail.artifacts.push({
      id: 'acceptance',
      content: JSON.stringify({
        criteria: [{ verificationMethod: 'COMMAND' }, { verificationMethod: 'MANUAL' }],
      }),
    } as never);
    detail.bindings.push({
      role: 'OUTPUT',
      key: 'software.acceptance',
      artifactId: 'acceptance',
    } as never);
    expect(
      await adapter.prepareExecution(
        detail.version.steps.find((s) => s.id === 'S06')!,
        detail,
        reviewer,
      ),
    ).toEqual({ routing: { executionConstraint: 'SOLO' } });
  });
  it('excludes every actual implementation/fix actor without inventing an independent self-review', async () => {
    const { adapter, detail, reviewer } = fixture();
    const result = await adapter.prepareExecution(
      detail.version.steps.find((s) => s.id === 'S08')!,
      detail,
      reviewer,
    );
    expect(result.routing?.excludedTeammateIds).toEqual(['author', 'actual-participant', 'fixer']);
    expect(result.routing?.executionConstraint).toBe('AUTO');
    expect(result.routing?.excludedTeammateIds).not.toContain('unexecuted-target');
  });
  it('does not create a mutation Mission without an explicit bounded target area', async () => {
    const { adapter, detail, reviewer } = fixture();
    detail.run.inputSnapshot!.targetArea = [];
    expect(
      await adapter.prepareExecution(
        detail.version.steps.find((s) => s.id === 'S05')!,
        detail,
        reviewer,
      ),
    ).toEqual({ reason: 'WORKSPACE_MUTATION_SCOPE_REQUIRED' });
  });
  it('preserves Workspace authority instead of trusting an arbitrary input path', async () => {
    const { adapter, detail, reviewer } = fixture();
    detail.run.inputSnapshot!.workspaceRoot = 'E:/outside';
    expect(await adapter.prepareExecution(detail.version.steps[0]!, detail, reviewer)).toEqual({
      reason: 'WORKSPACE_REQUIRED',
    });
  });
  it('uses durable Human Bridge for verification when no confirmed execution tool exists', async () => {
    const { adapter, detail, reviewer } = fixture();
    detail.run.inputSnapshot!.allowedToolScope = [];
    expect(
      await adapter.prepareExecution(
        detail.version.steps.find((s) => s.id === 'S06')!,
        detail,
        reviewer,
      ),
    ).toEqual({ routing: { executionConstraint: 'HUMAN_BRIDGE' } });
  });
});
